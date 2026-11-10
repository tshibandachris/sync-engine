'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed Electron preload scripts have a restricted require() surface.
// Keep these small shape/size checks inline; the main process repeats every
// validation and remains the security boundary.
const PRODUCT_FIELDS = new Set([
  'id', 'name', 'price', 'cost', 'sku', 'barcode', 'category', 'stockAlert',
]);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSearchQuery(value = '') {
  if (typeof value !== 'string' || value.length > 200) {
    throw new Error('Invalid product search query.');
  }
  return value;
}

function validateEnrollmentCredentials(value) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !['token', 'activationCode', 'deviceName'].includes(key)) ||
      typeof value.token !== 'string' || value.token.trim().length < 1 || value.token.length > 16384 ||
      typeof value.activationCode !== 'string' || !/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(value.activationCode.trim()) ||
      typeof value.deviceName !== 'string' || !value.deviceName.trim() || value.deviceName.trim().length > 120) {
    throw new Error('Invalid enrollment credentials.');
  }
  return { token: value.token.trim(), activationCode: value.activationCode.trim().toUpperCase(), deviceName: value.deviceName.trim() };
}

function validateProductInput(value) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !PRODUCT_FIELDS.has(key))) {
    throw new Error('Invalid product input.');
  }

  const limits = { id: 128, name: 200, sku: 64, barcode: 64, category: 80 };
  for (const [field, maxLength] of Object.entries(limits)) {
    if (value[field] !== undefined &&
        (typeof value[field] !== 'string' || value[field].length > maxLength)) {
      throw new Error(`Invalid product field: ${field}.`);
    }
  }
  for (const field of ['price', 'cost', 'stockAlert']) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && fieldValue !== null &&
        typeof fieldValue !== 'string' && typeof fieldValue !== 'number') {
      throw new Error(`Invalid product field: ${field}.`);
    }
    if (typeof fieldValue === 'string' && fieldValue.length > 32) {
      throw new Error(`Invalid product field: ${field}.`);
    }
    if (typeof fieldValue === 'number' && !Number.isFinite(fieldValue)) {
      throw new Error(`Invalid product field: ${field}.`);
    }
  }

  if (typeof value.name !== 'string' || !value.name.trim() ||
      value.price === undefined || value.price === null) {
    throw new Error('Product name and price are required.');
  }
  return {
    id: value.id,
    name: value.name,
    price: value.price,
    cost: value.cost,
    sku: value.sku,
    barcode: value.barcode,
    category: value.category,
    stockAlert: value.stockAlert,
  };
}

const api = Object.freeze({
  getStatus: () => ipcRenderer.invoke('eden:get-status'),
  refresh: () => ipcRenderer.invoke('eden:refresh'),
  getDashboard: () => ipcRenderer.invoke('eden:dashboard'),
  listProducts: (search = '') => ipcRenderer.invoke('eden:products:list', validateSearchQuery(search)),
  saveProduct: (product) => ipcRenderer.invoke('eden:products:save', validateProductInput(product)),
  enrollDevice: (credentials) => ipcRenderer.invoke('eden:device:enroll', validateEnrollmentCredentials(credentials)),
  checkDeviceApproval: () => ipcRenderer.invoke('eden:device:check-approval'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onStatus expects a function.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('eden:status', listener);
    return () => ipcRenderer.removeListener('eden:status', listener);
  },
});

contextBridge.exposeInMainWorld('eden', api);
