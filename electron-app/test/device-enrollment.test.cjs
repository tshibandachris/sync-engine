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


test('extractTenantIdFromDeviceToken reads the signed tenant claim for local continuity', () => {
  const { extractTenantIdFromDeviceToken } = require('../electron/auth/device-enrollment.cjs');
  assert.equal(extractTenantIdFromDeviceToken(jwt({ payload: { sub: 'device-1', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', exp: 4102444800 } })), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(extractTenantIdFromDeviceToken(jwt({ payload: { sub: 'device-1', tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', exp: 4102444800 } })), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
});

test('extractTenantIdFromDeviceToken rejects tokens without a tenant claim', () => {
  const { extractTenantIdFromDeviceToken } = require('../electron/auth/device-enrollment.cjs');
  assert.throws(
    () => extractTenantIdFromDeviceToken(jwt({ payload: { sub: 'device-1', exp: 4102444800 } })),
    /UUID valide/,
  );
});

test('extractTenantIdFromDeviceToken rejects non-UUID tenant claims', () => {
  const { extractTenantIdFromDeviceToken } = require('../electron/auth/device-enrollment.cjs');
  assert.throws(
    () => extractTenantIdFromDeviceToken(jwt({ payload: { sub: 'device-1', tenantId: 'tenant-a', exp: 4102444800 } })),
    /UUID valide/,
  );
});
