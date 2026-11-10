'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canAccessLocalPOS, canRunSync, deriveDeviceTrustState,
} = require('../electron/auth/device-state.cjs');

test('agent session grants local POS independently of device approval', () => {
  assert.equal(canAccessLocalPOS('authenticated', 'unregistered'), true);
  assert.equal(canAccessLocalPOS('unauthenticated', 'approved'), false);
  for (const trust of ['unregistered', 'awaiting_approval', 'approved', 'rejected', 'revoked', 'deactivated']) {
    assert.equal(canAccessLocalPOS('authenticated', trust), true, trust);
  }
});

test('sync requires an authenticated agent, server approval and ready proof transport', () => {
  assert.equal(canRunSync('authenticated', 'approved', true), true);
  assert.equal(canRunSync('authenticated', 'approved'), false);
  for (const trust of ['unregistered', 'awaiting_approval', 'rejected', 'revoked', 'deactivated']) {
    assert.equal(canRunSync('authenticated', trust, true), false, trust);
  }
  assert.equal(canRunSync('unauthenticated', 'approved', true), false);
});

test('a locally stored device key never implies approval', () => {
  assert.equal(deriveDeviceTrustState(null), 'unregistered');
  assert.equal(deriveDeviceTrustState({ deviceId: 'device-uuid' }), 'awaiting_approval');
  assert.equal(deriveDeviceTrustState({ deviceId: 'device-uuid', status: 'approved' }), 'awaiting_approval');
});
