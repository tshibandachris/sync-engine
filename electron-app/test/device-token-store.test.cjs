const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeviceTokenStore, TOKEN_FILENAME } = require('../electron/auth/device-token-store.cjs');

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-token-store-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'mock-secure',
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = value.toString('utf8');
      if (!text.startsWith('encrypted:')) throw new Error('invalid ciphertext');
      return text.slice('encrypted:'.length);
    },
    ...overrides,
  };
  const store = new DeviceTokenStore({ app: { getPath: () => root }, safeStorage });
  return { root, store, safeStorage, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('DeviceTokenStore persists only encrypted bytes and reads the JWT back', async () => {
  const f = fixture();
  try {
    const token = 'header.payload.signature';
    await f.store.setToken(token);
    const disk = fs.readFileSync(path.join(f.root, 'EdenGestion', TOKEN_FILENAME));
    assert.notEqual(disk.toString('utf8'), token);
    assert.match(disk.toString('utf8'), /^encrypted:/);
    assert.equal(await f.store.getToken(), token);
    assert.equal(await f.store.load(), token);
  } finally {
    f.cleanup();
  }
});

test('DeviceTokenStore fails closed when OS encryption is unavailable', async () => {
  const f = fixture({ isEncryptionAvailable: () => false });
  try {
    await assert.rejects(f.store.setToken('secret'), /OS-backed secret storage is unavailable/);
    await assert.rejects(f.store.getToken(), /OS-backed secret storage is unavailable/);
    assert.equal(fs.existsSync(path.join(f.root, 'EdenGestion', TOKEN_FILENAME)), false);
  } finally {
    f.cleanup();
  }
});

test('DeviceTokenStore rejects plaintext-only or unknown credential backends', async () => {
  for (const backend of ['basic_text', 'unknown']) {
    const f = fixture({ getSelectedStorageBackend: () => backend });
    try {
      await assert.rejects(f.store.setToken('secret'), /secure OS credential backend is unavailable/);
    } finally {
      f.cleanup();
    }
  }
});

test('DeviceTokenStore refuses corrupted ciphertext without plaintext fallback', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'EdenGestion'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'EdenGestion', TOKEN_FILENAME), 'plain-jwt-token');
    await assert.rejects(f.store.getToken(), /refusing plaintext fallback/);
  } finally {
    f.cleanup();
  }
});

test('DeviceTokenStore returns null only when no token file exists', async () => {
  const f = fixture();
  try {
    assert.equal(await f.store.getToken(), null);
  } finally {
    f.cleanup();
  }
});
