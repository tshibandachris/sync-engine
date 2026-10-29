const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertTrustedIpcSender,
  validateSearchQuery,
  validateEnrollmentCredentials,
  validateProductInput,
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
