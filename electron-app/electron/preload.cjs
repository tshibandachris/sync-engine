'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const {
  validateSearchQuery,
  validateEnrollmentCredentials,
  validateProductInput,
} = require('./security/ipc-security.cjs');

const api = Object.freeze({
  getStatus: () => ipcRenderer.invoke('eden:get-status'),
  refresh: () => ipcRenderer.invoke('eden:refresh'),
  getDashboard: () => ipcRenderer.invoke('eden:dashboard'),
  listProducts: (search = '') => ipcRenderer.invoke('eden:products:list', validateSearchQuery(search)),
  saveProduct: (product) => ipcRenderer.invoke('eden:products:save', validateProductInput(product)),
  enrollDevice: (credentials) => ipcRenderer.invoke('eden:device:enroll', validateEnrollmentCredentials(credentials)),
  onStatus: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onStatus expects a function.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('eden:status', listener);
    return () => ipcRenderer.removeListener('eden:status', listener);
  },
});

contextBridge.exposeInMainWorld('eden', api);
