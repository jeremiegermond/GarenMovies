const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startServer, getCatalog, scanFolder, getState, broadcastCatalog } = require('./server/server.cjs');
const { getAllMedia, addEmbeddedSubsToMedia, setMediaProbeInfo, getMedia } = require('./server/catalog.cjs');
const tunnel = require('./server/tunnel.cjs');
const metadata = require('./server/metadata.cjs');
const subtitles = require('./server/subtitles.cjs');
const subtitleDownloader = require('./server/subtitle-downloader.cjs');
const ffmpeg = require('./server/ffmpeg.cjs');
const vlc = require('./server/vlc.cjs');
const hls = require('./server/hls.cjs');
const torrents = require('./server/torrents.cjs');
const mpv = require('./mpv.cjs');
const { initAutoUpdate } = require('./updater.cjs');

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
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Drive the solo player's fullscreen state from the real window events.
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('solo:status', { fullscreen: true }));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('solo:status', { fullscreen: false }));

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
  }, 600); // coalesce bursts but still surface new posters/categories quickly
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
  // v6: bumped to discard partial cache files left by earlier builds that
  // didn't use the atomic-rename pattern (a Ctrl+C mid-encode left half-
  // written .mp4s that passed the size check but had no moov atom).
  const audioCacheDir = path.join(app.getPath('userData'), 'audio-cache-v6');
  try { fs.mkdirSync(audioCacheDir, { recursive: true }); } catch {}
  // Clean up any stale .tmp files (orphans from a previous crashed run).
  try {
    for (const name of fs.readdirSync(audioCacheDir)) {
      if (name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(audioCacheDir, name)); console.log('[cache] removed orphan', name); } catch {}
      }
    }
  } catch {}
  serverInfo = await startServer(SERVER_PORT, {
    audioCacheDir,
    importedSubsDir: path.join(app.getPath('userData'), 'imported-subs')
  });
  // Drop partial HLS segment dirs from a previous run (keep complete ones warm).
  hls.sweepPartials();

  // Log helper-tool availability so we know what's at our disposal.
  // NOTE: do NOT call vlc.getVLCVersion() here — `vlc.exe --version` pops a
  // modal dialog on Windows and blocks the spawnSync (and thus the whole main
  // process event loop) forever, so the window never opens. Path is enough.
  console.log('[ffmpeg]', ffmpeg.isAvailable() ? 'OK' : 'MISSING');
  if (vlc.isAvailable()) {
    console.log('[vlc] fallback available at', vlc.findVLC());
  } else {
    console.log('[vlc] not detected (install https://www.videolan.org/ for malformed-MKV fallback)');
  }
  // Pre-warm HW encoder detection so the first transcode doesn't pay the
  // -encoders / -hwaccels probe latency.
  ffmpeg.detectHwInfo().catch(() => {});
  metadata.setCachePath(path.join(app.getPath('userData'), 'metadata-cache.json'));
  subtitles.setCacheDir(path.join(app.getPath('userData'), 'subs-cache'));
  subtitleDownloader.setDownloadDir(path.join(app.getPath('userData'), 'downloaded-subs'));

  const cfg = loadConfig();
  if (cfg.tmdbApiKey) metadata.setApiKey(cfg.tmdbApiKey);
  if (cfg.openSubtitlesApiKey) subtitleDownloader.setApiKey(cfg.openSubtitlesApiKey);

  await createWindow();

  // Check GitHub Releases for a newer version and offer to install it.
  initAutoUpdate(() => mainWindow);

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
  hls.stopAll();
  mpv.stop();
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

// ── Torrent search + drag/drop hand-off ──
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v']);

ipcMain.handle('torrents:search', (_e, query) => torrents.search(query));

ipcMain.handle('torrents:open-magnet', async (_e, magnet) => {
  if (typeof magnet !== 'string' || !magnet.startsWith('magnet:')) return { error: 'Lien magnet invalide' };
  await shell.openExternal(magnet); // hands off to the user's default torrent client
  return { ok: true };
});

ipcMain.handle('torrents:open-file', async (_e, filePath) => {
  const err = await shell.openPath(filePath); // .torrent → default client
  return err ? { error: err } : { ok: true };
});

// Drop video files onto the app → copy them into the shared scan folder and
// rescan so they show up in the library. Copy (not move) to keep the source.
ipcMain.handle('torrents:add-videos', async (_e, paths) => {
  const cfg = loadConfig();
  if (!cfg.scanFolder) return { error: 'Aucun dossier de bibliothèque configuré. Choisis-en un d’abord.' };
  const list = Array.isArray(paths) ? paths : [];
  let added = 0;
  const skipped = [];
  for (const src of list) {
    const ext = path.extname(src).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) { skipped.push(path.basename(src)); continue; }
    const dest = path.join(cfg.scanFolder, path.basename(src));
    try {
      if (path.resolve(src) !== path.resolve(dest)) await fs.promises.copyFile(src, dest);
      added++;
    } catch (e) {
      console.error('[torrents] copy failed for', src, e.message);
      skipped.push(path.basename(src));
    }
  }
  if (added > 0) {
    try {
      await scanFolder(cfg.scanFolder);
      broadcastCatalog();
      processInBackground(getAllMedia());
    } catch (e) { console.error('Rescan after add failed:', e); }
  }
  return { added, skipped };
});

// ── Solo mode (native mpv player) ──
mpv.on('property', (name, data) => {
  const patch = {};
  if (name === 'time-pos' && data != null) patch.position = data;
  else if (name === 'duration' && data != null) patch.duration = data;
  else if (name === 'pause') patch.paused = !!data;
  else return;
  mainWindow?.webContents.send('solo:status', patch);
});
mpv.on('stopped', () => mainWindow?.webContents.send('solo:status', { stopped: true }));
mpv.on('error', (e) => mainWindow?.webContents.send('solo:status', { error: e.message }));

ipcMain.handle('solo:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Choisis un film à regarder en solo',
    filters: [{ name: 'Vidéos', extensions: ['mp4', 'mkv', 'avi', 'webm', 'mov', 'm4v'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
// A frameless child window that hosts mpv's rendering, positioned over the
// app's video area (mpv can't be an HTML overlay — it's a native surface).
let mpvWin = null;
function ensureMpvWindow() {
  if (mpvWin && !mpvWin.isDestroyed()) return mpvWin;
  try {
    mpvWin = new BrowserWindow({
      parent: mainWindow, frame: false, transparent: true, backgroundColor: '#00000000',
      show: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, focusable: false, hasShadow: false, webPreferences: {}
    });
    mpvWin.on('closed', () => { mpvWin = null; });
  } catch (e) { console.warn('[solo] mpv child window failed:', e.message); mpvWin = null; }
  return mpvWin;
}
function mpvWid() {
  if (!mpvWin || mpvWin.isDestroyed()) return null;
  try { return mpvWin.getNativeWindowHandle().readBigUInt64LE(0).toString(); }
  catch { return null; }
}

let mpvHidden = false; // intentionally hidden (e.g. while an HTML dialog is open over the video)
// The mpv video is a native window over the web page, so the renderer never
// sees mouse-move over the video. Poll the cursor here and notify the renderer
// so it can show/auto-hide the controls in fullscreen.
let cursorWatch = null, lastCursor = null;
function startCursorWatch() {
  if (cursorWatch) return;
  cursorWatch = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (!lastCursor || p.x !== lastCursor.x || p.y !== lastCursor.y) {
      lastCursor = p;
      mainWindow.webContents.send('solo:status', { activity: Date.now() });
    }
  }, 250);
}
function stopCursorWatch() { if (cursorWatch) { clearInterval(cursorWatch); cursorWatch = null; } }

ipcMain.handle('solo:open', async (_e, filePath) => {
  const win = ensureMpvWindow();
  const wid = win ? mpvWid() : null;
  try {
    await mpv.loadFile(filePath, wid);      // wid → embedded; null → mpv's own window (fallback)
    mpvHidden = false;
    if (win) win.showInactive();
    startCursorWatch();
    return { ok: true, embedded: !!wid };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('solo:region', (_e, rect) => {
  if (!mpvWin || mpvWin.isDestroyed() || !mainWindow || !rect) return;
  const cb = mainWindow.getContentBounds();
  try {
    mpvWin.setBounds({
      x: Math.round(cb.x + (rect.x || 0)),
      y: Math.round(cb.y + (rect.y || 0)),
      width: Math.max(1, Math.round(rect.width || 0)),
      height: Math.max(1, Math.round(rect.height || 0))
    });
    if (!mpvHidden && !mpvWin.isVisible()) mpvWin.showInactive();
  } catch {}
});
// Hide/show the native mpv window so HTML overlays (subtitle search, etc.) can
// appear over the video area (mpv is a native surface — HTML can't float on it).
ipcMain.handle('solo:set-visible', (_e, visible) => {
  if (!mpvWin || mpvWin.isDestroyed()) return;
  mpvHidden = !visible;
  if (visible) mpvWin.showInactive(); else mpvWin.hide();
});
ipcMain.handle('solo:toggle', () => mpv.togglePause());
ipcMain.handle('solo:volume', (_e, v) => mpv.setVolume(v));
ipcMain.handle('solo:seek', (_e, t) => mpv.seekAbsolute(t));
ipcMain.handle('solo:seek-rel', (_e, d) => mpv.seekRelative(d));
ipcMain.handle('solo:fullscreen', () => {
  if (!mainWindow) return false;
  const v = !mainWindow.isFullScreen();
  // Briefly hide the always-on-top mpv child so it doesn't block the parent's
  // fullscreen transition; the region poll re-shows + repositions it after.
  const wasVisible = mpvWin && !mpvWin.isDestroyed() && mpvWin.isVisible();
  if (wasVisible) mpvWin.hide();
  mainWindow.setFullScreen(v);
  if (wasVisible) setTimeout(() => { if (mpvWin && !mpvWin.isDestroyed() && !mpvHidden) mpvWin.showInactive(); }, 300);
  return v;
});
ipcMain.handle('solo:load-subtitle', (_e, { mediaId, subIdx } = {}) => {
  try {
    const sub = getMedia(mediaId)?.subs?.[subIdx];
    if (sub?.path) { mpv.addSubtitle(sub.path); return { ok: true }; }
    return { ok: false };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('solo:position', () => mpv.getPosition());
ipcMain.handle('solo:stop', () => { mpv.stop(); stopCursorWatch(); if (mpvWin && !mpvWin.isDestroyed()) mpvWin.hide(); });

ipcMain.handle('subs:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Choisis un fichier de sous-titres',
    filters: [{ name: 'Sous-titres', extensions: ['srt', 'vtt', 'ass'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
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
