const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eden', {
  getStatus: () => ipcRenderer.invoke('eden:get-status'),
  refresh: () => ipcRenderer.invoke('eden:refresh'),
  getDashboard: () => ipcRenderer.invoke('eden:dashboard'),
  listProducts: (search = '') => ipcRenderer.invoke('eden:products:list', search),
  saveProduct: (product) => ipcRenderer.invoke('eden:products:save', product),
  enrollDevice: (credentials) => ipcRenderer.invoke('eden:device:enroll', credentials),
  onStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('eden:status', listener);
    return () => ipcRenderer.removeListener('eden:status', listener);
  },
});
