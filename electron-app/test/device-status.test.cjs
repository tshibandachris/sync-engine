'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceStatusService } = require('../electron/auth/device-status.cjs');

const DEVICE_ID = '00000000-0000-4000-8000-000000000111';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('status polling sends agent JWT and device ID, then reports server approval', async () => {
  const transitions = [];
  let request;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test/',
    getAgentToken: () => 'agent-jwt',
    getDeviceId: () => DEVICE_ID,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, {
        deviceId: DEVICE_ID,
        approvalStatus: 'approved',
        isActive: true,
        hasActiveCredential: true,
        serverTime: '2026-11-10T12:00:00.000Z',
      });
    },
    onStatus: (status) => transitions.push(status),
  });

  const result = await service.checkStatus();
  assert.equal(result.success, true);
  assert.equal(result.approvalStatus, 'approved');
  assert.equal(request.url, 'https://sync.example.test/api/v1/devices/status');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.authorization, 'Bearer agent-jwt');
  assert.equal(request.options.headers['x-device-id'], DEVICE_ID);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].approvalStatus, 'approved');
});

test('pending, rejected and revoked are reported as distinct server states', async () => {
  for (const approvalStatus of ['pending_approval', 'rejected', 'revoked']) {
    let observed;
    const service = new DeviceStatusService({
      baseUrl: 'https://sync.example.test',
      getAgentToken: () => 'agent-jwt',
      getDeviceId: () => DEVICE_ID,
      fetchImpl: async () => response(200, {
        deviceId: DEVICE_ID,
        approvalStatus,
        isActive: true,
        hasActiveCredential: false,
      }),
      onStatus: (status) => { observed = status; },
    });
    const result = await service.checkStatus();
    assert.equal(result.success, true);
    assert.equal(observed.approvalStatus, approvalStatus);
  }
});

test('network and server refusals preserve state by never calling transition callback', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('network unavailable'); },
    async () => response(403, { code: 'DEVICE_PENDING_APPROVAL', message: 'Pending' }),
  ]) {
    let transitions = 0;
    const service = new DeviceStatusService({
      baseUrl: 'https://sync.example.test',
      getAgentToken: () => 'agent-jwt',
      getDeviceId: () => DEVICE_ID,
      fetchImpl,
      onStatus: () => { transitions += 1; },
    });
    const result = await service.checkStatus();
    assert.equal(result.success, false);
    assert.equal(transitions, 0);
  }
});

test('rejects a mismatched device ID or malformed approval response', async () => {
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => 'agent-jwt',
    getDeviceId: () => DEVICE_ID,
    fetchImpl: async () => response(200, {
      deviceId: '00000000-0000-4000-8000-000000000222',
      approvalStatus: 'approved',
      isActive: true,
      hasActiveCredential: true,
    }),
  });
  const result = await service.checkStatus();
  assert.equal(result.success, false);
  assert.match(result.error, /expected server contract/);
});

test('does not call the network without both agent and device identities', async () => {
  let calls = 0;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => null,
    getDeviceId: () => DEVICE_ID,
    fetchImpl: async () => { calls += 1; return response(200, {}); },
  });
  const result = await service.checkStatus();
  assert.equal(result.reason, 'NOT_ENROLLED_OR_UNAUTHENTICATED');
  assert.equal(calls, 0);
});
