const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDeviceToken } = require('../electron/auth/device-enrollment.cjs');

function segment(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function jwt({ header = { alg: 'RS256', typ: 'JWT' }, payload = { sub: 'agent', tenantId: 'tenant', exp: 4102444800 }, signature = 'signature' } = {}) {
  return `${segment(header)}.${segment(payload)}.${Buffer.from(signature).toString('base64url')}`;
}

test('validateDeviceToken accepts a structurally valid, unexpired JWT without modifying it', () => {
  const token = `  ${jwt()}  `;
  assert.equal(validateDeviceToken(token), token.trim());
});

test('validateDeviceToken rejects non-JWT and malformed JSON segments', () => {
  assert.throws(() => validateDeviceToken('not-a-jwt'), /trois segments/);
  assert.throws(() => validateDeviceToken('@@.e30.c2ln'), /header/);
  assert.throws(() => validateDeviceToken('e30.@@.c2ln'), /payload/);
});

test('validateDeviceToken rejects unsigned JWTs and missing signatures', () => {
  assert.throws(() => validateDeviceToken(jwt({ header: { alg: 'none' } })), /algorithme/);
  assert.throws(() => validateDeviceToken(`${segment({ alg: 'RS256' })}.${segment({})}.`), /signature/);
});

test('validateDeviceToken rejects expired or malformed expiration claims', () => {
  assert.throws(() => validateDeviceToken(jwt({ payload: { exp: 1 } }), 2000), /expiré/);
  assert.throws(() => validateDeviceToken(jwt({ payload: { exp: 'tomorrow' } })), /expiré/);
});
