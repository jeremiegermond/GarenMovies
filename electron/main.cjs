const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startServer, getCatalog, scanFolder, getState, broadcastCatalog } = require('./server/server.cjs');
const { getAllMedia, addEmbeddedSubsToMedia } = require('./server/catalog.cjs');
const tunnel = require('./server/tunnel.cjs');
const metadata = require('./server/metadata.cjs');
const subtitles = require('./server/subtitles.cjs');

const isDev = !app.isPackaged;
const SERVER_PORT = 4123;

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
      probeAllMKVs(items)
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

app.whenReady().then(async () => {
  serverInfo = await startServer(SERVER_PORT);
  metadata.setCachePath(path.join(app.getPath('userData'), 'metadata-cache.json'));
  subtitles.setCacheDir(path.join(app.getPath('userData'), 'subs-cache'));

  const cfg = loadConfig();
  if (cfg.tmdbApiKey) metadata.setApiKey(cfg.tmdbApiKey);

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
