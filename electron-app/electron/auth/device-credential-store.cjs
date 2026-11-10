'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertKeyPair, calculateJwkThumbprint } = require('./device-crypto.cjs');

const CREDENTIAL_FILENAME = 'device-credential.enc';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class DeviceCredentialStore {
  constructor({ app, safeStorage, fsImpl = fs }) {
    if (!app || typeof app.getPath !== 'function') {
      throw new TypeError('DeviceCredentialStore requires Electron app.getPath().');
    }
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' ||
        typeof safeStorage.encryptString !== 'function' ||
        typeof safeStorage.decryptString !== 'function') {
      throw new TypeError('DeviceCredentialStore requires Electron safeStorage encryption APIs.');
    }
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.directory = path.join(app.getPath('appData'), 'EdenGestion');
    this.filePath = path.join(this.directory, CREDENTIAL_FILENAME);
  }

  assertEncryptionAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed secret storage is unavailable; device credential access is disabled.');
    }
    if (typeof this.safeStorage.getSelectedStorageBackend === 'function') {
      const backend = this.safeStorage.getSelectedStorageBackend();
      if (!backend || backend === 'basic_text' || backend === 'unknown') {
        throw new Error('A secure OS credential backend is unavailable; device credential access is disabled.');
      }
    }
  }

  validateCredential(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !UUID_RE.test(value.deviceId || '') ||
        typeof value.privateKeyPem !== 'string' ||
        typeof value.publicKeyPem !== 'string' ||
        typeof value.thumbprint !== 'string' ||
        value.algorithm !== 'ES256' ||
        (value.tenantId !== undefined && !UUID_RE.test(value.tenantId)) ||
        (value.approvalStatus !== undefined && !['pending_approval', 'approved', 'rejected', 'revoked'].includes(value.approvalStatus)) ||
        (value.pendingEnrollment !== undefined && typeof value.pendingEnrollment !== 'boolean')) {
      throw new Error('Stored device credential has an invalid shape.');
    }
    assertKeyPair(value.privateKeyPem, value.publicKeyPem);
    if (calculateJwkThumbprint(value.publicKeyPem) !== value.thumbprint) {
      throw new Error('Stored device credential thumbprint does not match its public key.');
    }
    return {
      deviceId: value.deviceId,
      privateKeyPem: value.privateKeyPem,
      publicKeyPem: value.publicKeyPem,
      thumbprint: value.thumbprint,
      algorithm: 'ES256',
      ...(value.tenantId ? { tenantId: value.tenantId } : {}),
      ...(value.approvalStatus ? { approvalStatus: value.approvalStatus } : {}),
      ...(value.pendingEnrollment === true ? { pendingEnrollment: true } : {}),
    };
  }

  async load() {
    this.assertEncryptionAvailable();
    if (!this.fs.existsSync(this.filePath)) return null;
    try {
      const encrypted = this.fs.readFileSync(this.filePath);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new Error('Encrypted device credential file is empty or invalid.');
      }
      const plaintext = this.safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(plaintext);
      return this.validateCredential(parsed);
    } catch (error) {
      throw new Error('Unable to decrypt or validate the stored device credential; refusing plaintext fallback.', { cause: error });
    }
  }

  async savePending(credential) {
    return this.save({ ...credential, pendingEnrollment: true });
  }

  async save(credential) {
    this.assertEncryptionAvailable();
    const validated = this.validateCredential(credential);
    this.fs.mkdirSync(this.directory, { recursive: true });
    const encrypted = this.safeStorage.encryptString(JSON.stringify(validated));
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new Error('OS encryption did not return a valid encrypted device credential.');
    }
    const temporaryPath = this.filePath + '.tmp';
    try {
      this.fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
      this.fs.renameSync(temporaryPath, this.filePath);
      try { this.fs.chmodSync(this.filePath, 0o600); } catch { /* Windows ACLs govern access on Windows. */ }
    } catch (error) {
      try { this.fs.rmSync(temporaryPath, { force: true }); } catch { /* Preserve the original error. */ }
      throw new Error('Unable to persist the encrypted device credential.', { cause: error });
    }
  }

  async clear() {
    this.assertEncryptionAvailable();
    this.fs.rmSync(this.filePath, { force: true });
  }
}

module.exports = { CREDENTIAL_FILENAME, DeviceCredentialStore };
