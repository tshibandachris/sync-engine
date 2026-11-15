const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertTrustedIpcSender,
  validateSearchQuery,
  validateEnrollmentCredentials,
  validateDeviceEnrollmentInput,
  validateProductInput,
  validateOpenCashSessionInput,
  validateCreateSaleInput,
} = require('../electron/security/ipc-security.cjs');

function trustedEvent() {
  const frame = { url: 'file:///app/electron/renderer/index.html' };
  const sender = { mainFrame: frame, getURL: () => frame.url };
  return { event: { sender, senderFrame: frame }, windowRef: { webContents: sender } };
}

test('IPC sender accepts only the current main frame of the app window', () => {
  const trusted = trustedEvent();
  assert.doesNotThrow(() => assertTrustedIpcSender(trusted.event, trusted.windowRef));

  assert.throws(() => assertTrustedIpcSender({ ...trusted.event, senderFrame: {} }, trusted.windowRef), /not authorized/);
  assert.throws(() => assertTrustedIpcSender({ ...trusted.event, sender: {} }, trusted.windowRef), /not authorized/);
  assert.throws(() => assertTrustedIpcSender(trusted.event, null), /not authorized/);
});

test('IPC sender rejects remote pages even when they are the main frame', () => {
  const frame = { url: 'https://attacker.invalid/' };
  const sender = { mainFrame: frame, getURL: () => frame.url };
  assert.throws(
    () => assertTrustedIpcSender({ sender, senderFrame: frame }, { webContents: sender }),
    /not authorized/,
  );
});

test('product search accepts bounded strings only', () => {
  assert.equal(validateSearchQuery('café'), 'café');
  assert.equal(validateSearchQuery(''), '');
  assert.throws(() => validateSearchQuery({}), /Invalid product search/);
  assert.throws(() => validateSearchQuery('x'.repeat(201)), /Invalid product search/);
});

test('enrollment credentials accept only a bounded token field', () => {
  assert.deepEqual(validateEnrollmentCredentials({ token: 'a.b.c' }), { token: 'a.b.c' });
  assert.throws(() => validateEnrollmentCredentials({ token: 'a.b.c', extra: true }), /Invalid enrollment/);
  assert.throws(() => validateEnrollmentCredentials({ token: '' }), /Invalid enrollment/);
  assert.throws(() => validateEnrollmentCredentials({ token: 'x'.repeat(16385) }), /Invalid enrollment/);
});


test('device enrollment IPC accepts only activation code and bounded device name', () => {
  assert.deepEqual(validateDeviceEnrollmentInput({
    activationCode: 'abcd-1234',
    deviceName: 'Caisse principale',
  }), {
    activationCode: 'ABCD-1234',
    deviceName: 'Caisse principale',
  });
  assert.throws(() => validateDeviceEnrollmentInput({ activationCode: 'bad', deviceName: 'Caisse' }), /code d'activation/i);
  assert.throws(() => validateDeviceEnrollmentInput({
    activationCode: 'ABCD-1234', deviceName: 'x'.repeat(121),
  }), /nom du terminal/);
  assert.throws(() => validateDeviceEnrollmentInput({
    activationCode: 'ABCD-1234', deviceName: 'Caisse', privateKeyPem: 'secret',
  }), /Invalid device enrollment input/);
});

test('product IPC accepts the supported DTO and rejects unknown or oversized fields', () => {
  assert.deepEqual(validateProductInput({
    id: undefined, name: 'Farine', price: '2500', cost: '1800',
    sku: 'FAR-1', barcode: '', category: 'Alimentation', stockAlert: '5',
  }), {
    id: undefined, name: 'Farine', price: '2500', cost: '1800',
    sku: 'FAR-1', barcode: '', category: 'Alimentation', stockAlert: '5',
  });
  assert.throws(() => validateProductInput({ name: 'Farine', price: 2, isAdmin: true }), /Invalid product input/);
  assert.throws(() => validateProductInput({ name: 'x'.repeat(201), price: 2 }), /Invalid product field/);
  assert.throws(() => validateProductInput({ name: 'Farine', price: { value: 2 } }), /Invalid product field/);
  assert.throws(() => validateProductInput({ name: ' ', price: 2 }), /required/);
});

test('cash-session IPC accepts only a valid cashier and integer CDF opening float', () => {
  const staffId = '00000000-0000-4000-8000-000000000101';
  assert.deepEqual(validateOpenCashSessionInput({ staffId, openingAmount: 12000 }), { staffId, openingAmount: 12000, terminalLabel: null });
  assert.throws(() => validateOpenCashSessionInput({ staffId, openingAmount: -1 }), /fond de caisse/);
  assert.throws(() => validateOpenCashSessionInput({ staffId, openingAmount: 1.5 }), /fond de caisse/);
  assert.throws(() => validateOpenCashSessionInput({ staffId, openingAmount: 0, isAdmin: true }), /Invalid cash session/);
});

test('sale IPC accepts bounded UUID product lines and integer payment fields', () => {
  const input = { cashSessionId: '00000000-0000-4000-8000-000000000102', lines: [{ productId: '00000000-0000-4000-8000-000000000103', quantity: 2 }], paymentMethod: 'mixed', cashAmount: 600, mobileAmount: 400 };
  assert.deepEqual(validateCreateSaleInput(input), { ...input, mobileMsisdn: null, mobileReference: null, customerNote: null });
  assert.throws(() => validateCreateSaleInput({ ...input, lines: [{ productId: 'bad', quantity: 1 }] }), /ligne/);
  assert.throws(() => validateCreateSaleInput({ ...input, extra: true }), /Invalid sale input/);
  assert.throws(() => validateCreateSaleInput({ ...input, cashAmount: 1.5 }), /répartition/);
});