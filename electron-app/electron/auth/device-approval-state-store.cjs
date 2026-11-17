'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APPROVAL_STATE_FILENAME = 'device-approval-state.enc';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_STATES = new Set(['pending_approval', 'approved', 'rejected', 'revoked']);

class DeviceApprovalStateStore {
  constructor({ app, safeStorage, fsImpl = fs }) {
    if (!app || typeof app.getPath !== 'function') {
      throw new TypeError('DeviceApprovalStateStore requires Electron app.getPath().');
    }
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' ||
        typeof safeStorage.encryptString !== 'function' ||
        typeof safeStorage.decryptString !== 'function') {
      throw new TypeError('DeviceApprovalStateStore requires Electron safeStorage encryption APIs.');
    }
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.directory = path.join(app.getPath('appData'), 'EdenGestion');
    this.filePath = path.join(this.directory, APPROVAL_STATE_FILENAME);
  }

  assertEncryptionAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed secret storage is unavailable; cached device approval is disabled.');
    }
    if (typeof this.safeStorage.getSelectedStorageBackend === 'function') {
      const backend = this.safeStorage.getSelectedStorageBackend();
      if (!backend || backend === 'basic_text' || backend === 'unknown') {
        throw new Error('A secure OS credential backend is unavailable; cached device approval is disabled.');
      }
    }
  }

  validateState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !UUID_RE.test(value.deviceId || '') ||
        !UUID_RE.test(value.tenantId || '') ||
        !APPROVAL_STATES.has(value.approvalStatus) ||
        typeof value.isActive !== 'boolean' ||
        typeof value.hasActiveCredential !== 'boolean' ||
        !UUID_RE.test(value.decisionVersion || '') ||
        typeof value.confirmedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.confirmedAt)) ||
        new Date(value.confirmedAt).toISOString() !== value.confirmedAt) {
      throw new Error('Stored device approval decision has an invalid shape.');
    }
    return {
      deviceId: value.deviceId,
      tenantId: value.tenantId,
      approvalStatus: value.approvalStatus,
      isActive: value.isActive,
      hasActiveCredential: value.hasActiveCredential,
      decisionVersion: value.decisionVersion,
      confirmedAt: value.confirmedAt,
    };
  }

  async load() {
    this.assertEncryptionAvailable();
    if (!this.fs.existsSync(this.filePath)) return null;
    try {
      const encrypted = this.fs.readFileSync(this.filePath);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new Error('Encrypted device approval file is empty or invalid.');
      }
      return this.validateState(JSON.parse(this.safeStorage.decryptString(encrypted)));
    } catch (error) {
      throw new Error('Unable to decrypt or validate the stored device approval decision; refusing plaintext fallback.', { cause: error });
    }
  }

  async save(state) {
    this.assertEncryptionAvailable();
    const validated = this.validateState(state);
    this.fs.mkdirSync(this.directory, { recursive: true });
    const encrypted = this.safeStorage.encryptString(JSON.stringify(validated));
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new Error('OS encryption did not return a valid encrypted device approval decision.');
    }
    const temporaryPath = this.filePath + '.tmp';
    try {
      this.fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
      this.fs.renameSync(temporaryPath, this.filePath);
      try { this.fs.chmodSync(this.filePath, 0o600); } catch { /* Windows ACLs govern access on Windows. */ }
      const persistedBytes = this.fs.readFileSync(this.filePath);
      const persisted = this.validateState(JSON.parse(this.safeStorage.decryptString(persistedBytes)));
      if (JSON.stringify(persisted) !== JSON.stringify(validated)) {
        throw new Error('Persisted device approval decision does not match the confirmed server state.');
      }
    } catch (error) {
      try { this.fs.rmSync(temporaryPath, { force: true }); } catch { /* Preserve the original error. */ }
      throw new Error('Unable to persist the encrypted device approval decision.', { cause: error });
    }
  }

  async clear() {
    this.assertEncryptionAvailable();
    this.fs.rmSync(this.filePath, { force: true });
  }
}

module.exports = { APPROVAL_STATE_FILENAME, DeviceApprovalStateStore };
