'use strict';

const PRODUCT_FIELDS = new Set([
  'id', 'name', 'price', 'cost', 'sku', 'barcode', 'category', 'stockAlert',
]);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertTrustedIpcSender(event, windowRef) {
  const sender = event?.sender;
  const frame = event?.senderFrame;
  if (!windowRef?.webContents || sender !== windowRef.webContents ||
      !frame || frame !== sender.mainFrame) {
    throw new Error('IPC sender not authorized.');
  }

  const senderUrl = typeof sender.getURL === 'function' ? sender.getURL() : '';
  if (!senderUrl || frame.url !== senderUrl) {
    throw new Error('IPC sender URL not authorized.');
  }

  let protocol;
  try {
    protocol = new URL(senderUrl).protocol;
  } catch {
    throw new Error('IPC sender URL not authorized.');
  }
  if (protocol !== 'file:') throw new Error('IPC sender URL not authorized.');
}

function validateSearchQuery(value = '') {
  if (typeof value !== 'string' || value.length > 200) {
    throw new Error('Invalid product search query.');
  }
  return value;
}

function validateEnrollmentCredentials(value) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== 'token') ||
      typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 16384) {
    throw new Error('Invalid enrollment credentials.');
  }
  return { token: value.token };
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

module.exports = {
  assertTrustedIpcSender,
  validateSearchQuery,
  validateEnrollmentCredentials,
  validateProductInput,
};
