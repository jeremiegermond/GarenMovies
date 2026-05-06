const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startServer, getCatalog, scanFolder, getState, broadcastCatalog } = require('./server/server.cjs');
const tunnel = require('./server/tunnel.cjs');

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
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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

app.whenReady().then(async () => {
  serverInfo = await startServer(SERVER_PORT);
  await createWindow();

  const cfg = loadConfig();
  if (cfg.scanFolder) {
    try {
      await scanFolder(cfg.scanFolder);
      broadcastCatalog();
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
  return entries;
});

ipcMain.handle('catalog:rescan', async () => {
  const cfg = loadConfig();
  if (!cfg.scanFolder) return [];
  const entries = await scanFolder(cfg.scanFolder);
  broadcastCatalog();
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
