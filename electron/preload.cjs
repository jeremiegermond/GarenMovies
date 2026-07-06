const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Electron 32+ removed File.path; this is the supported way to get the real
  // filesystem path of a drag-and-dropped file.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getServerInfo: () => ipcRenderer.invoke('server:info'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  scanFolder: (folder) => ipcRenderer.invoke('catalog:scan', folder),
  rescan: () => ipcRenderer.invoke('catalog:rescan'),
  getCatalog: () => ipcRenderer.invoke('catalog:list'),
  getState: () => ipcRenderer.invoke('state:get'),
  tunnel: {
    start: () => ipcRenderer.invoke('tunnel:start'),
    stop: () => ipcRenderer.invoke('tunnel:stop'),
    status: () => ipcRenderer.invoke('tunnel:status'),
    onURL: (cb) => {
      const handler = (_e, url) => cb(url);
      ipcRenderer.on('tunnel:url', handler);
      return () => ipcRenderer.removeListener('tunnel:url', handler);
    }
  },
  torrents: {
    search: (query) => ipcRenderer.invoke('torrents:search', query),
    openMagnet: (magnet) => ipcRenderer.invoke('torrents:open-magnet', magnet),
    openFile: (filePath) => ipcRenderer.invoke('torrents:open-file', filePath),
    addVideos: (paths) => ipcRenderer.invoke('torrents:add-videos', paths)
  },
  update: {
    onStatus: (cb) => {
      const handler = (_e, status) => cb(status);
      ipcRenderer.on('update:status', handler);
      return () => ipcRenderer.removeListener('update:status', handler);
    },
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    check: () => ipcRenderer.invoke('update:check')
  }
});
