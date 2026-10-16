const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eden', {
  getStatus: () => ipcRenderer.invoke('eden:get-status'),
  refresh: () => ipcRenderer.invoke('eden:refresh'),
});
