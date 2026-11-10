const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDeviceToken, getMachineFingerprint, getHardwareInfo, FINGERPRINT_FILENAME } = require('../electron/auth/device-enrollment.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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


test('installation fingerprint is persisted and stable without exposing hardware identifiers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-installation-fingerprint-'));
  try {
    const app = { getPath: () => root };
    const first = getMachineFingerprint(app);
    const second = getMachineFingerprint(app);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(second, first);
    assert.equal(fs.readFileSync(path.join(root, 'EdenGestion', FINGERPRINT_FILENAME), 'utf8').trim(), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hardware information is limited to the documented platform fields', () => {
  const info = getHardwareInfo({
    hostname: () => 'POS-01',
    platform: () => 'win32',
    arch: () => 'x64',
    release: () => '10.0.19045',
  });
  assert.deepEqual(info, {
    hostname: 'POS-01', platform: 'win32', arch: 'x64', osRelease: '10.0.19045',
  });
});
