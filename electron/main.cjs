const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startServer, getCatalog, scanFolder, getState, broadcastCatalog } = require('./server/server.cjs');
const { getAllMedia, addEmbeddedSubsToMedia, setMediaProbeInfo } = require('./server/catalog.cjs');
const tunnel = require('./server/tunnel.cjs');
const metadata = require('./server/metadata.cjs');
const subtitles = require('./server/subtitles.cjs');
const subtitleDownloader = require('./server/subtitle-downloader.cjs');
const ffmpeg = require('./server/ffmpeg.cjs');
const vlc = require('./server/vlc.cjs');

const isDev = !app.isPackaged;
const SERVER_PORT = 4123;

// Safety net: third-party libraries (matroska-subtitles via ebml-stream, etc.)
// can throw synchronously from inside Transform._write on malformed input.
// Those throws bypass per-stream .on('error') handlers and would otherwise
// crash the Electron main process with a modal error dialog. We log and keep
// running — actual logic-level errors should still be caught at their source.
function truncate(s, n = 800) {
  if (typeof s !== 'string') s = String(s);
  return s.length > n ? s.slice(0, n) + ' …[truncated]' : s;
}
function isKnownNoise(err) {
  const msg = err && err.message ? String(err.message) : String(err || '');
  // matroska-subtitles -> ebml-stream throws asynchronously after we close
  // the source stream during subtitle probing. Already handled by the
  // pipeline error path in subtitles.cjs — the async throw is harmless.
  return msg.startsWith('Unrepresentable length: Infinity')
    || msg.includes('Premature close');
}
process.on('uncaughtException', (err) => {
  if (isKnownNoise(err)) return;
  const msg = err && err.stack ? err.stack : String(err);
  console.error('[uncaughtException]', truncate(msg));
});
process.on('unhandledRejection', (reason) => {
  if (isKnownNoise(reason)) return;
  const msg = reason && reason.stack ? reason.stack : String(reason);
  console.error('[unhandledRejection]', truncate(msg));
});

let mainWindow = null;
let serverInfo = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastCatalog();
  }, 1500);
}

let processing = false;
async function processInBackground(items) {
  if (processing) return;
  processing = true;
  try {
    await Promise.all([
      metadata.hasApiKey()
        ? metadata.enrichBatch(items, () => scheduleBroadcast())
        : Promise.resolve(),
      probeAllMKVs(items),
      probeAllAudioTracks(items)
    ]);
  } finally {
    processing = false;
    broadcastCatalog();
  }
}

async function probeAllMKVs(items) {
  if (!subtitles.isMkvSupported()) return;
  for (const item of items) {
    if (item.source.ext !== 'mkv') continue;
    if (item.subs.some((s) => s.type === 'embedded')) continue;
    try {
      const tracks = await subtitles.probeMkv(item.source.path);
      if (tracks.length > 0) {
        addEmbeddedSubsToMedia(item.id, tracks);
        scheduleBroadcast();
      }
    } catch (e) {
      console.error('MKV probe failed for', item.title, e.message);
    }
  }
}

async function probeAllAudioTracks(items) {
  if (!ffmpeg.isAvailable()) return;
  for (const item of items) {
    if (item.videoCodec || (item.audioTracks && item.audioTracks.length > 0)) continue;
    try {
      const info = await ffmpeg.probeFile(item.source.path);
      if (info && (info.audioTracks?.length > 0 || info.videoCodec)) {
        setMediaProbeInfo(item.id, info);
        scheduleBroadcast();
      }
    } catch (e) {
      console.error('Audio probe failed for', item.title, e.message);
    }
  }
}

app.whenReady().then(async () => {
  // v5: bumped to invalidate any cached files that may have been produced by
  // earlier builds without the output-size validation in remuxWithAudio.
  const audioCacheDir = path.join(app.getPath('userData'), 'audio-cache-v5');
  serverInfo = await startServer(SERVER_PORT, { audioCacheDir });

  // Log helper-tool availability so we know what's at our disposal.
  console.log('[ffmpeg]', ffmpeg.isAvailable() ? 'OK' : 'MISSING');
  if (vlc.isAvailable()) {
    console.log('[vlc] fallback available at', vlc.findVLC(), '— version', vlc.getVLCVersion() || '?');
  } else {
    console.log('[vlc] not detected (install https://www.videolan.org/ for malformed-MKV fallback)');
  }
  metadata.setCachePath(path.join(app.getPath('userData'), 'metadata-cache.json'));
  subtitles.setCacheDir(path.join(app.getPath('userData'), 'subs-cache'));
  subtitleDownloader.setDownloadDir(path.join(app.getPath('userData'), 'downloaded-subs'));

  const cfg = loadConfig();
  if (cfg.tmdbApiKey) metadata.setApiKey(cfg.tmdbApiKey);
  if (cfg.openSubtitlesApiKey) subtitleDownloader.setApiKey(cfg.openSubtitlesApiKey);

  await createWindow();

  if (cfg.scanFolder) {
    try {
      await scanFolder(cfg.scanFolder);
      broadcastCatalog();
      processInBackground(getAllMedia());
    } catch (e) {
      console.error('Auto-rescan failed:', e);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await tunnel.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (tunnel.isRunning()) {
    e.preventDefault();
    await tunnel.stop();
    app.quit();
  }
});

ipcMain.handle('server:info', () => ({
  port: serverInfo?.port ?? SERVER_PORT,
  lanIPs: getLanIPs()
}));

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, patch) => {
  const cfg = loadConfig();
  Object.assign(cfg, patch || {});
  saveConfig(cfg);
  if (patch && patch.tmdbApiKey !== undefined) {
    metadata.setApiKey(patch.tmdbApiKey);
    processInBackground(getAllMedia());
  }
  if (patch && patch.openSubtitlesApiKey !== undefined) {
    subtitleDownloader.setApiKey(patch.openSubtitlesApiKey);
  }
  return cfg;
});

ipcMain.handle('dialog:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choisis le dossier de films à partager'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('catalog:scan', async (_e, folder) => {
  const entries = await scanFolder(folder);
  const cfg = loadConfig();
  cfg.scanFolder = folder;
  saveConfig(cfg);
  broadcastCatalog();
  processInBackground(getAllMedia());
  return entries;
});

ipcMain.handle('catalog:rescan', async () => {
  const cfg = loadConfig();
  if (!cfg.scanFolder) return [];
  const entries = await scanFolder(cfg.scanFolder);
  broadcastCatalog();
  processInBackground(getAllMedia());
  return entries;
});

ipcMain.handle('catalog:list', () => getCatalog());
ipcMain.handle('state:get', () => getState());

ipcMain.handle('tunnel:start', async () => {
  try {
    const url = await tunnel.start(
      serverInfo.port,
      (u) => mainWindow?.webContents.send('tunnel:url', u),
      (log) => mainWindow?.webContents.send('tunnel:log', log)
    );
    return { url };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('tunnel:stop', async () => {
  await tunnel.stop();
  mainWindow?.webContents.send('tunnel:url', null);
  return { ok: true };
});

ipcMain.handle('tunnel:status', () => ({
  running: tunnel.isRunning(),
  url: tunnel.getURL()
}));
