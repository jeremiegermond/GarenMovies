const { autoUpdater } = require('electron-updater');
const { app, ipcMain } = require('electron');

// In-app auto-update via GitHub Releases (see build.publish in package.json).
// Instead of native dialogs, we relay every autoUpdater event to the renderer
// ('update:status') so it can show a custom modal with detailed steps and a
// real download progress bar. The renderer drives the flow back through IPC
// ('update:download', 'update:install', 'update:check').
//
// Only runs in a packaged build; in dev electron-updater has no update metadata
// and would throw ("dev-app-update.yml not found").
function initAutoUpdate(getWindow) {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;          // ask before pulling the file
  autoUpdater.autoInstallOnAppQuit = true;   // if they defer, install on next quit

  const send = (payload) => {
    try { getWindow?.()?.webContents.send('update:status', payload); } catch {}
  };

  autoUpdater.on('checking-for-update', () => send({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ phase: 'available', version: info?.version }));
  autoUpdater.on('update-not-available', () => send({ phase: 'none' }));
  autoUpdater.on('download-progress', (p) => send({
    phase: 'downloading',
    percent: Math.round(p?.percent || 0),
    bytesPerSecond: p?.bytesPerSecond || 0,
    transferred: p?.transferred || 0,
    total: p?.total || 0
  }));
  autoUpdater.on('update-downloaded', (info) => send({ phase: 'downloaded', version: info?.version }));
  autoUpdater.on('error', (err) => send({ phase: 'error', message: String(err?.message || err) }));

  let checking = false;
  async function check() {
    if (checking) return;
    checking = true;
    try { await autoUpdater.checkForUpdates(); }
    catch (e) { console.warn('[updater] check failed:', e?.message); send({ phase: 'error', message: e?.message }); }
    finally { checking = false; }
  }

  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:download', () => {
    autoUpdater.downloadUpdate().catch((e) => send({ phase: 'error', message: e?.message }));
    return true;
  });
  ipcMain.handle('update:install', () => {
    // Silent install (/S → no installer wizard) and relaunch the app once it's
    // done, so updating never leaves the app from the user's point of view.
    // Let the IPC reply flush before quitting.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });

  // Don't block startup — check a few seconds after the window is up.
  setTimeout(check, 4000);
}

module.exports = { initAutoUpdate };
