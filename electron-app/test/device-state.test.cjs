'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  canAccessLocalPOS,
  canReadLocalData,
  canRunSync,
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
  assert.match(source, /registerTrustedHandler\('eden:dashboard', \(\) => \{\s*assertLocalReadAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:products:list',[\s\S]*?assertLocalReadAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:get-state',[\s\S]*?assertLocalReadAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:products:save',[\s\S]*?assertBusinessWriteAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:open-session',[\s\S]*?assertBusinessWriteAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:create-sale',[\s\S]*?assertBusinessWriteAccess\(\);/);
  assert.match(source, /registerTrustedHandler\('eden:pos:close-session',[\s\S]*?assertBusinessWriteAccess\(\);/);
});
