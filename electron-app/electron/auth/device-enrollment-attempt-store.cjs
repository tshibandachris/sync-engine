'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertKeyPair, calculateJwkThumbprint } = require('./device-crypto.cjs');

const ATTEMPT_FILENAME = 'device-enrollment-attempt.enc';
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

class DeviceEnrollmentAttemptStore {
  constructor({ app, safeStorage, fsImpl = fs }) {
    if (!app || typeof app.getPath !== 'function') {
      throw new TypeError('DeviceEnrollmentAttemptStore requires Electron app.getPath().');
    }
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' ||
        typeof safeStorage.encryptString !== 'function' ||
        typeof safeStorage.decryptString !== 'function') {
      throw new TypeError('DeviceEnrollmentAttemptStore requires Electron safeStorage APIs.');
    }
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.directory = path.join(app.getPath('appData'), 'EdenGestion');
    this.filePath = path.join(this.directory, ATTEMPT_FILENAME);
  }

  assertEncryptionAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed secret storage is unavailable; pending enrollment cannot be persisted.');
    }
    if (typeof this.safeStorage.getSelectedStorageBackend === 'function') {
      const backend = this.safeStorage.getSelectedStorageBackend();
      if (!backend || backend === 'basic_text' || backend === 'unknown') {
        throw new Error('A secure OS credential backend is unavailable; pending enrollment is disabled.');
      }
    }
  }

  validateAttempt(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !CODE_RE.test(value.activationCode || '') ||
        typeof value.deviceName !== 'string' || !value.deviceName.trim() || value.deviceName.length > 120 ||
        !value.hardwareInfo || typeof value.hardwareInfo !== 'object' || Array.isArray(value.hardwareInfo) ||
        typeof value.fingerprint !== 'string' || !value.fingerprint.trim() || value.fingerprint.length > 255 ||
        typeof value.privateKeyPem !== 'string' || typeof value.publicKeyPem !== 'string' ||
        typeof value.thumbprint !== 'string' || value.algorithm !== 'ES256' ||
        typeof value.initialProof !== 'string' || value.initialProof.split('.').length !== 3) {
      throw new Error('Pending device enrollment attempt has an invalid shape.');
    }
    assertKeyPair(value.privateKeyPem, value.publicKeyPem);
    if (calculateJwkThumbprint(value.publicKeyPem) !== value.thumbprint) {
      throw new Error('Pending enrollment thumbprint does not match its public key.');
    }
    return {
      activationCode: value.activationCode,
      deviceName: value.deviceName,
      hardwareInfo: value.hardwareInfo,
      fingerprint: value.fingerprint,
      privateKeyPem: value.privateKeyPem,
      publicKeyPem: value.publicKeyPem,
      thumbprint: value.thumbprint,
      algorithm: 'ES256',
      initialProof: value.initialProof,
    };
  }

  async save(attempt) {
    this.assertEncryptionAvailable();
    const validated = this.validateAttempt(attempt);
    this.fs.mkdirSync(this.directory, { recursive: true });
    const encrypted = this.safeStorage.encryptString(JSON.stringify(validated));
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new Error('OS encryption did not return a valid pending enrollment envelope.');
    }
    const temporaryPath = this.filePath + '.tmp';
    try {
      this.fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
      this.fs.renameSync(temporaryPath, this.filePath);
      try { this.fs.chmodSync(this.filePath, 0o600); } catch { /* Windows ACLs govern access on Windows. */ }
    } catch (error) {
      try { this.fs.rmSync(temporaryPath, { force: true }); } catch { /* Preserve original error. */ }
      throw new Error('Unable to persist the encrypted pending enrollment attempt.', { cause: error });
    }
  }

  async load() {
    this.assertEncryptionAvailable();
    if (!this.fs.existsSync(this.filePath)) return null;
    try {
      const encrypted = this.fs.readFileSync(this.filePath);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('Encrypted attempt file is empty.');
      return this.validateAttempt(JSON.parse(this.safeStorage.decryptString(encrypted)));
    } catch (error) {
      throw new Error('Unable to decrypt or validate pending enrollment; refusing plaintext fallback.', { cause: error });
    }
  }

  async clear() {
    this.assertEncryptionAvailable();
    this.fs.rmSync(this.filePath, { force: true });
  }
}

module.exports = { ATTEMPT_FILENAME, DeviceEnrollmentAttemptStore };
