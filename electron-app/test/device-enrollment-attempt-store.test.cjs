'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DeviceEnrollmentAttemptStore, ATTEMPT_FILENAME } = require('../electron/auth/device-enrollment-attempt-store.cjs');
const { generateDeviceKeyPair } = require('../electron/auth/device-crypto.cjs');

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-enrollment-attempt-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'mock-secure',
    encryptString: (value) => Buffer.from('encrypted:' + value, 'utf8'),
    decryptString: (value) => {
      const text = value.toString('utf8');
      if (!text.startsWith('encrypted:')) throw new Error('invalid ciphertext');
      return text.slice('encrypted:'.length);
    },
    ...overrides,
  };
  return {
    root,
    store: new DeviceEnrollmentAttemptStore({ app: { getPath: () => root }, safeStorage }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function attempt() {
  const pair = generateDeviceKeyPair();
  const activationCode = 'ABCD-1234';
  const fingerprint = crypto.createHash('sha256').update('host-fingerprint').digest('hex');
  return {
    activationCode,
    deviceName: 'Caisse principale',
    hardwareInfo: { hostname: 'pos-01', platform: 'win32', arch: 'x64', osRelease: '10.0' },
    fingerprint,
    privateKeyPem: pair.privateKeyPem,
    publicKeyPem: pair.publicKeyPem,
    thumbprint: pair.thumbprint,
    algorithm: 'ES256',
    jti: crypto.randomUUID(),
  };
}

test('persists the exact initial proof and private key only in encrypted storage for safe retry', async () => {
  const f = fixture();
  try {
    const value = attempt();
    await f.store.save(value);
    const bytes = fs.readFileSync(path.join(f.root, 'EdenGestion', ATTEMPT_FILENAME));
    assert.notEqual(bytes.toString('utf8'), JSON.stringify(value));
    assert.match(bytes.toString('utf8'), /^encrypted:/);
    assert.deepEqual(await f.store.load(), value);
  } finally {
    f.cleanup();
  }
});

test('rejects a pending attempt whose key thumbprint does not match', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.store.save({ ...attempt(), thumbprint: 'wrong' }), /thumbprint/);
  } finally {
    f.cleanup();
  }
});

test('fails closed when OS encryption is unavailable', async () => {
  const f = fixture({ isEncryptionAvailable: () => false });
  try {
    await assert.rejects(f.store.save(attempt()), /unavailable/);
  } finally {
    f.cleanup();
  }
});

test('returns null only when there is no pending attempt and clears after completion', async () => {
  const f = fixture();
  try {
    assert.equal(await f.store.load(), null);
    await f.store.save(attempt());
    await f.store.clear();
    assert.equal(await f.store.load(), null);
  } finally {
    f.cleanup();
  }
});
