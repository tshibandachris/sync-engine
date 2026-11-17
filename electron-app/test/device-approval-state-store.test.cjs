'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  APPROVAL_STATE_FILENAME,
  DeviceApprovalStateStore,
} = require('../electron/auth/device-approval-state-store.cjs');
const {
  canAccessLocalPOS,
  deriveDeviceTrustState,
} = require('../electron/auth/device-state.cjs');

const DEVICE_ID = '00000000-0000-4000-8000-000000000111';
const TENANT_ID = '00000000-0000-4000-8000-000000000222';

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-device-approval-'));
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
    createStore: () => new DeviceApprovalStateStore({ app: { getPath: () => root }, safeStorage }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function approvedDecision(overrides = {}) {
  return {
    deviceId: DEVICE_ID,
    tenantId: TENANT_ID,
    approvalStatus: 'approved',
    isActive: true,
    hasActiveCredential: true,
    decisionVersion: crypto.randomUUID(),
    confirmedAt: '2026-11-16T06:00:00.000Z',
    ...overrides,
  };
}

const credential = { deviceId: DEVICE_ID, tenantId: TENANT_ID };

test('restores the last confirmed approval after a fresh store instance simulates application restart', async () => {
  const f = fixture();
  try {
    const firstProcessStore = f.createStore();
    const decision = approvedDecision();
    await firstProcessStore.save(decision);

    const secondProcessStore = f.createStore();
    const restored = await secondProcessStore.load();

    assert.deepEqual(restored, decision);
    const trustState = deriveDeviceTrustState(credential, restored);
    assert.equal(trustState, 'approved');
    assert.equal(canAccessLocalPOS('authenticated', trustState), true);
    assert.equal(restored.deviceId, DEVICE_ID);
    assert.equal(restored.tenantId, TENANT_ID);
    assert.ok(restored.decisionVersion);
    assert.equal(restored.confirmedAt, decision.confirmedAt);
  } finally {
    f.cleanup();
  }
});

test('does not restore an approval decision bound to another device or tenant', async () => {
  const decision = approvedDecision();
  assert.equal(
    deriveDeviceTrustState(credential, { ...decision, deviceId: '00000000-0000-4000-8000-000000000999' }),
    'awaiting_approval',
  );
  assert.equal(
    deriveDeviceTrustState(credential, { ...decision, tenantId: '00000000-0000-4000-8000-000000000999' }),
    'awaiting_approval',
  );
  assert.equal(canAccessLocalPOS('authenticated', 'awaiting_approval'), false);
});

test('restores rejection, revocation and deactivation as non-writable trust states', async () => {
  const decision = approvedDecision();
  assert.equal(deriveDeviceTrustState(credential, { ...decision, approvalStatus: 'rejected' }), 'rejected');
  assert.equal(deriveDeviceTrustState(credential, { ...decision, approvalStatus: 'revoked', hasActiveCredential: false }), 'revoked');
  assert.equal(deriveDeviceTrustState(credential, { ...decision, isActive: false }), 'deactivated');
  for (const state of ['rejected', 'revoked', 'deactivated']) {
    assert.equal(canAccessLocalPOS('authenticated', state), false, state);
  }
});

test('stores approval decisions only as OS-encrypted bytes and refuses plaintext fallback', async () => {
  const f = fixture();
  try {
    const store = f.createStore();
    const decision = approvedDecision();
    await store.save(decision);
    const filePath = path.join(f.root, 'EdenGestion', APPROVAL_STATE_FILENAME);
    const bytes = fs.readFileSync(filePath);
    assert.notEqual(bytes.toString('utf8'), JSON.stringify(decision));
    assert.match(bytes.toString('utf8'), /^encrypted:/);
    await store.clear();
    assert.equal(await store.load(), null);
  } finally {
    f.cleanup();
  }
});

test('rejects malformed decisions and unsafe or unavailable OS storage', async () => {
  const f = fixture();
  try {
    const store = f.createStore();
    await assert.rejects(store.save({ ...approvedDecision(), tenantId: undefined }), /invalid shape/);
    await assert.rejects(store.save({ ...approvedDecision(), approvalStatus: 'unknown' }), /invalid shape/);
    await assert.rejects(store.save({ ...approvedDecision(), decisionVersion: 'not-a-uuid' }), /invalid shape/);
  } finally {
    f.cleanup();
  }

  for (const overrides of [
    { isEncryptionAvailable: () => false },
    { getSelectedStorageBackend: () => 'basic_text' },
  ]) {
    const unsafe = fixture(overrides);
    try {
      await assert.rejects(unsafe.createStore().save(approvedDecision()), /secure|unavailable/);
    } finally {
      unsafe.cleanup();
    }
  }
});

test('fails closed when the encrypted approval decision is corrupted', async () => {
  const f = fixture();
  try {
    const filePath = path.join(f.root, 'EdenGestion', APPROVAL_STATE_FILENAME);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'plaintext-or-corrupted');
    await assert.rejects(f.createStore().load(), /refusing plaintext fallback/);
  } finally {
    f.cleanup();
  }
});
