const fs = require('node:fs');
const path = require('node:path');

const TOKEN_FILENAME = 'device-token.enc';

class DeviceTokenStore {
  constructor({ app, safeStorage, fsImpl = fs }) {
    if (!app || typeof app.getPath !== 'function') {
      throw new TypeError('DeviceTokenStore requires Electron app.getPath().');
    }
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' ||
        typeof safeStorage.encryptString !== 'function' ||
        typeof safeStorage.decryptString !== 'function') {
      throw new TypeError('DeviceTokenStore requires Electron safeStorage encryption APIs.');
    }
    this.app = app;
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.directory = path.join(app.getPath('appData'), 'EdenGestion');
    this.filePath = path.join(this.directory, TOKEN_FILENAME);
  }

  assertEncryptionAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed secret storage is unavailable; device authentication is disabled.');
    }
    if (typeof this.safeStorage.getSelectedStorageBackend === 'function') {
      const backend = this.safeStorage.getSelectedStorageBackend();
      if (!backend || backend === 'basic_text' || backend === 'unknown') {
        throw new Error('A secure OS credential backend is unavailable; device authentication is disabled.');
      }
    }
  }

  async load() {
    return this.getToken();
  }

  async getToken() {
    this.assertEncryptionAvailable();
    if (!this.fs.existsSync(this.filePath)) return null;

    let encrypted;
    try {
      encrypted = this.fs.readFileSync(this.filePath);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new Error('Encrypted device token file is empty or invalid.');
      }
      const token = this.safeStorage.decryptString(encrypted);
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Decrypted device token is empty or invalid.');
      }
      return token;
    } catch (error) {
      throw new Error('Unable to decrypt the stored device token; refusing plaintext fallback.', { cause: error });
    }
  }

  async setToken(token) {
    this.assertEncryptionAvailable();
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new TypeError('A non-empty device JWT is required.');
    }

    this.fs.mkdirSync(this.directory, { recursive: true });
    const encrypted = this.safeStorage.encryptString(token);
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new Error('OS encryption did not return a valid encrypted device token.');
    }

    const temporaryPath = `${this.filePath}.tmp`;
    try {
      this.fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
      this.fs.renameSync(temporaryPath, this.filePath);
      try { this.fs.chmodSync(this.filePath, 0o600); } catch { /* Windows ACLs govern access on Windows. */ }
    } catch (error) {
      try { this.fs.rmSync(temporaryPath, { force: true }); } catch { /* Preserve the original write error. */ }
      throw new Error('Unable to persist the encrypted device token.', { cause: error });
    }
  }
}

module.exports = { DeviceTokenStore, TOKEN_FILENAME };
