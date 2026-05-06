const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getServerInfo: () => ipcRenderer.invoke('server:info'),
  getConfig: () => ipcRenderer.invoke('config:get'),
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
  }
});
