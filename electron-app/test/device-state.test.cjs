'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canAccessLocalPOS, canRunSync, deriveDeviceTrustState,
} = require('../electron/auth/device-state.cjs');

test('agent session grants local POS independently of device approval', () => {
  assert.equal(canAccessLocalPOS('authenticated', 'unregistered'), true);
  assert.equal(canAccessLocalPOS('unauthenticated', 'approved'), false);
  for (const trust of ['unregistered', 'awaiting_approval', 'approved', 'revoked']) {
    assert.equal(canAccessLocalPOS('authenticated', trust), true, trust);
  }
});

test('sync requires both an authenticated agent and an approved device', () => {
  assert.equal(canRunSync('authenticated', 'approved'), true);
  for (const trust of ['unregistered', 'awaiting_approval', 'revoked']) {
    assert.equal(canRunSync('authenticated', trust), false, trust);
  }
  assert.equal(canRunSync('unauthenticated', 'approved'), false);
});

test('a locally stored device key never implies approval', () => {
  assert.equal(deriveDeviceTrustState(null), 'unregistered');
  assert.equal(deriveDeviceTrustState({ deviceId: 'device-uuid' }), 'awaiting_approval');
  assert.equal(deriveDeviceTrustState({ deviceId: 'device-uuid', status: 'approved' }), 'awaiting_approval');
});
