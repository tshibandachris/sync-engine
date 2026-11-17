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


function validateDeviceEnrollmentInput(value) {
  if (!isPlainRecord(value) ||
      Object.keys(value).some((key) => !['activationCode', 'deviceName'].includes(key))) {
    throw new Error('Invalid device enrollment input.');
  }
  const activationCode = typeof value.activationCode === 'string'
    ? value.activationCode.trim().toUpperCase()
    : '';
  const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim() : '';
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(activationCode)) {
    throw new Error("Le code d'activation doit respecter le format XXXX-XXXX.");
  }
  if (!deviceName || deviceName.length > 120) {
    throw new Error('Le nom du terminal doit contenir entre 1 et 120 caractères.');
  }
  return { activationCode, deviceName };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateOpenCashSessionInput(value) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !['staffId', 'openingAmount', 'terminalLabel'].includes(key))) throw new Error('Invalid cash session input.');
  if (typeof value.staffId !== 'string' || !UUID_RE.test(value.staffId) || !Number.isSafeInteger(value.openingAmount) || value.openingAmount < 0) {
    throw new Error('Le caissier et le fond de caisse doivent être valides.');
  }
  if (value.terminalLabel !== undefined && value.terminalLabel !== null && (typeof value.terminalLabel !== 'string' || value.terminalLabel.length > 40)) throw new Error('Nom du terminal invalide.');
  return { staffId: value.staffId, openingAmount: value.openingAmount, terminalLabel: value.terminalLabel ?? null };
}

function validateCloseCashSessionInput(value) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !['cashSessionId', 'closingAmount', 'notes'].includes(key)) || typeof value.cashSessionId !== 'string' || !UUID_RE.test(value.cashSessionId) || !Number.isSafeInteger(value.closingAmount) || value.closingAmount < 0 || (value.notes !== undefined && value.notes !== null && (typeof value.notes !== 'string' || value.notes.length > 500))) throw new Error('Invalid cash-session close input.');
  return { cashSessionId: value.cashSessionId, closingAmount: value.closingAmount, notes: value.notes ?? null };
}

function validateCreateSaleInput(value) {
  const allowed = new Set(['cashSessionId', 'lines', 'paymentMethod', 'cashAmount', 'mobileAmount', 'mobileMsisdn', 'mobileReference', 'customerNote']);
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.has(key)) || typeof value.cashSessionId !== 'string' || !UUID_RE.test(value.cashSessionId) || !Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 100) throw new Error('Invalid sale input.');
  const lines = value.lines.map((line) => {
    if (!isPlainRecord(line) || Object.keys(line).some((key) => !['productId', 'quantity'].includes(key)) || typeof line.productId !== 'string' || !UUID_RE.test(line.productId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 100000) throw new Error('Une ligne du panier est invalide.');
    return { productId: line.productId, quantity: line.quantity };
  });
  if (!['cash', 'mobile_money', 'mixed'].includes(value.paymentMethod) || !Number.isSafeInteger(value.cashAmount) || value.cashAmount < 0 || !Number.isSafeInteger(value.mobileAmount) || value.mobileAmount < 0) throw new Error('Mode ou répartition du paiement invalide.');
  const limits = { mobileMsisdn: 20, mobileReference: 64, customerNote: 200 };
  for (const [field, max] of Object.entries(limits)) if (value[field] !== undefined && value[field] !== null && (typeof value[field] !== 'string' || value[field].length > max)) throw new Error('Champ invalide : ' + field + '.');
  return { cashSessionId: value.cashSessionId, lines, paymentMethod: value.paymentMethod, cashAmount: value.cashAmount, mobileAmount: value.mobileAmount, mobileMsisdn: value.mobileMsisdn ?? null, mobileReference: value.mobileReference ?? null, customerNote: value.customerNote ?? null };
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
  validateDeviceEnrollmentInput,
  validateProductInput,
  validateOpenCashSessionInput,
  validateCreateSaleInput,
  validateCloseCashSessionInput,
};
