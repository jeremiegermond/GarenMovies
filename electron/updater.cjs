const { autoUpdater } = require('electron-updater');
const { dialog, app } = require('electron');

// In-app auto-update via GitHub Releases (see build.publish in package.json).
// Flow, all through native dialogs (no renderer involvement):
//   startup → check → "update available" pop-up → download → "install now?" pop-up.
// Only runs in a packaged build; in dev electron-updater has no update metadata
// and would throw ("dev-app-update.yml not found").
function initAutoUpdate(getWindow) {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;          // ask before pulling the file
  autoUpdater.autoInstallOnAppQuit = true;   // if they defer, install on next quit

  let checking = false;

  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err?.message || err);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });

  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox(getWindow?.() || null, {
      type: 'info',
      buttons: ['Télécharger', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
      title: 'Mise à jour disponible',
      message: `GarenMovies ${info.version} est disponible`,
      detail: 'Voulez-vous la télécharger maintenant ? Elle s’installera au redémarrage.'
    });
    if (response === 0) autoUpdater.downloadUpdate().catch((e) => console.warn('[updater] download failed:', e?.message));
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(getWindow?.() || null, {
      type: 'info',
      buttons: ['Redémarrer et installer', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
      title: 'Mise à jour prête',
      message: `GarenMovies ${info.version} est téléchargée`,
      detail: 'Redémarrer maintenant pour l’installer ?'
    });
    if (response === 0) {
      // Let the dialog close before quitting.
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  async function check() {
    if (checking) return;
    checking = true;
    try { await autoUpdater.checkForUpdates(); }
    catch (e) { console.warn('[updater] check failed:', e?.message); }
    finally { checking = false; }
  }

  // Don't block startup — check a few seconds after the window is up.
  setTimeout(check, 4000);
}

module.exports = { initAutoUpdate };
