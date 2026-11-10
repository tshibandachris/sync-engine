const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DeviceCredentialStore, CREDENTIAL_FILENAME } = require('../electron/auth/device-credential-store.cjs');
const { generateDeviceKeyPair } = require('../electron/auth/device-crypto.cjs');

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-device-credential-'));
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
    safeStorage,
    store: new DeviceCredentialStore({ app: { getPath: () => root }, safeStorage }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function credential(deviceId = crypto.randomUUID()) {
  const pair = generateDeviceKeyPair();
  return {
    deviceId,
    privateKeyPem: pair.privateKeyPem,
    publicKeyPem: pair.publicKeyPem,
    thumbprint: pair.thumbprint,
    algorithm: 'ES256',
  };
}

test('stores device ID and private key only as OS-encrypted bytes and verifies the read-back', async () => {
  const f = fixture();
  try {
    const value = credential();
    await f.store.save(value);
    const bytes = fs.readFileSync(path.join(f.root, 'EdenGestion', CREDENTIAL_FILENAME));
    assert.notEqual(bytes.toString('utf8'), JSON.stringify(value));
    assert.match(bytes.toString('utf8'), /^encrypted:/);
    assert.deepEqual(await f.store.load(), value);
  } finally {
    f.cleanup();
  }
});

test('rejects credentials whose public/private keys do not match', async () => {
  const f = fixture();
  try {
    const value = credential();
    const foreign = generateDeviceKeyPair();
    await assert.rejects(f.store.save({ ...value, publicKeyPem: foreign.publicKeyPem, thumbprint: foreign.thumbprint }), /do not form/);
  } finally {
    f.cleanup();
  }
});

test('rejects a thumbprint that does not match the public key', async () => {
  const f = fixture();
  try {
    const value = credential();
    await assert.rejects(f.store.save({ ...value, thumbprint: 'wrong-thumbprint' }), /thumbprint/);
  } finally {
    f.cleanup();
  }
});

test('fails closed when OS encryption is unavailable or insecure', async () => {
  for (const overrides of [
    { isEncryptionAvailable: () => false },
    { getSelectedStorageBackend: () => 'basic_text' },
  ]) {
    const f = fixture(overrides);
    try {
      await assert.rejects(f.store.save(credential()), /secure|unavailable/);
      assert.equal(fs.existsSync(path.join(f.root, 'EdenGestion', CREDENTIAL_FILENAME)), false);
    } finally {
      f.cleanup();
    }
  }
});

test('does not fall back to plaintext when the encrypted credential is corrupted', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'EdenGestion'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'EdenGestion', CREDENTIAL_FILENAME), 'plain-private-key');
    await assert.rejects(f.store.load(), /refusing plaintext fallback/);
  } finally {
    f.cleanup();
  }
});

test('returns null only when no credential file exists', async () => {
  const f = fixture();
  try {
    assert.equal(await f.store.load(), null);
  } finally {
    f.cleanup();
  }
});


test('persists a recoverable pending enrollment and later approved tenant binding', async () => {
  const f = fixture();
  try {
    const value = credential();
    await f.store.savePending(value);
    const pending = await f.store.load();
    assert.equal(pending.pendingEnrollment, true);
    assert.equal(pending.deviceId, value.deviceId);

    const tenantId = crypto.randomUUID();
    await f.store.save({ ...pending, pendingEnrollment: false, tenantId, approvalStatus: 'pending_approval' });
    const registered = await f.store.load();
    assert.equal(registered.pendingEnrollment, undefined);
    assert.equal(registered.tenantId, tenantId);
    assert.equal(registered.approvalStatus, 'pending_approval');

    await f.store.save({ ...registered, approvalStatus: 'approved' });
    assert.equal((await f.store.load()).approvalStatus, 'approved');
  } finally {
    f.cleanup();
  }
});
