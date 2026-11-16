'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  canAccessLocalPOS,
  canReadLocalData,
  canRunSync,
  deriveDeviceTrustState,
} = require('../electron/auth/device-state.cjs');

test('unregistered terminals cannot read or write business data', () => {
  assert.equal(canReadLocalData('authenticated', 'unregistered'), false);
  assert.equal(canAccessLocalPOS('authenticated', 'unregistered'), false);
  assert.equal(canReadLocalData('unauthenticated', 'approved'), false);
  assert.equal(canAccessLocalPOS('unauthenticated', 'approved'), false);
});

test('pending activation permits consultation only', () => {
  assert.equal(canReadLocalData('authenticated', 'awaiting_approval'), true);
  assert.equal(canAccessLocalPOS('authenticated', 'awaiting_approval'), false);
  assert.equal(canRunSync('authenticated', 'awaiting_approval', true), false);
});

test('restores only a matching persisted server decision and keeps unconfirmed credentials read-only', () => {
  const credential = {
    deviceId: '00000000-0000-4000-8000-000000000111',
    tenantId: '00000000-0000-4000-8000-000000000222',
  };
  const approved = {
    deviceId: credential.deviceId,
    tenantId: credential.tenantId,
    approvalStatus: 'approved',
    isActive: true,
    hasActiveCredential: true,
    decisionVersion: '00000000-0000-4000-8000-000000000333',
    confirmedAt: '2026-11-16T06:00:00.000Z',
  };
  assert.equal(deriveDeviceTrustState(credential, approved), 'approved');
  assert.equal(deriveDeviceTrustState(credential, { ...approved, tenantId: '00000000-0000-4000-8000-000000000999' }), 'awaiting_approval');
  assert.equal(deriveDeviceTrustState(credential, null), 'awaiting_approval');
  assert.equal(canAccessLocalPOS('authenticated', deriveDeviceTrustState(credential, null)), false);
});

test('server approval enables offline-first local operations and eligible sync', () => {
  assert.equal(canReadLocalData('authenticated', 'approved'), true);
  assert.equal(canAccessLocalPOS('authenticated', 'approved'), true);
  assert.equal(canRunSync('authenticated', 'approved', true), true);
  // A transient network/API failure must not rewrite the approved trust state.
  assert.equal(canAccessLocalPOS('authenticated', 'approved'), true);
});

test('rejected and revoked terminals are read-only and cannot synchronize', () => {
  for (const trustState of ['rejected', 'revoked']) {
    assert.equal(canReadLocalData('authenticated', trustState), true, trustState);
    assert.equal(canAccessLocalPOS('authenticated', trustState), false, trustState);
    assert.equal(canRunSync('authenticated', trustState, true), false, trustState);
  }
});

test('deactivated terminals fail closed for writes and retain read access', () => {
  assert.equal(canReadLocalData('authenticated', 'deactivated'), true);
  assert.equal(canAccessLocalPOS('authenticated', 'deactivated'), false);
  assert.equal(canRunSync('authenticated', 'deactivated', true), false);
});

test('main-process IPC handlers enforce read and write policy independently of renderer state', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(source, /tenantId: serverEnrollment\.tenantId/);
  assert.match(source, /getTenantId: \(\) => deviceCredential\?\.tenantId \|\| null/);
  assert.match(source, /new DeviceApprovalStateStore\(\{ app, safeStorage \}\)/);
  assert.match(source, /deviceApprovalState = await approvalStateStore\.load\(\)/);
  assert.match(source, /await approvalStateStore\.save\(persistedDecision\)/);
  assert.match(source, /deviceTrustState = deriveDeviceTrustState\(deviceCredential, deviceApprovalState\)/);
  assert.match(source, /registerTrustedHandler\('eden:dashboard', \(\) => \{\s*assertLocalReadAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:products:list',[\s\S]*?assertLocalReadAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:get-state',[\s\S]*?assertLocalReadAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:products:save',[\s\S]*?assertBusinessWriteAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:open-session',[\s\S]*?assertBusinessWriteAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:create-sale',[\s\S]*?assertBusinessWriteAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:close-session',[\s\S]*?assertBusinessWriteAccess\(\);/);
});
