'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateDeviceKeyPair } = require('../electron/auth/device-crypto.cjs');
const { DeviceStatusService } = require('../electron/auth/device-status.cjs');
const { canAccessLocalPOS } = require('../electron/auth/device-state.cjs');

const DEVICE_ID = '00000000-0000-4000-8000-000000000111';
const TENANT_ID = '00000000-0000-4000-8000-000000000222';
const TOKEN = 'agent-jwt';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function verifyStatusProof(request, pair) {
  const proof = request.options.headers['x-device-proof'];
  assert.equal(typeof proof, 'string');
  const [headerB64, payloadB64, signatureB64] = proof.split('.');
  assert.equal(proof.split('.').length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')), {
    alg: 'ES256',
    typ: 'dpop+jwt',
  });
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  assert.equal(payload.htm, 'GET');
  assert.equal(payload.htu, '/api/v1/devices/status');
  assert.equal(payload.ath, crypto.createHash('sha256').update(TOKEN).digest('base64url'));
  assert.match(payload.jti, /^[0-9a-f-]{36}$/i);
  assert.equal(Buffer.from(signatureB64, 'base64url').length, 64);
  assert.equal(crypto.verify(
    'sha256',
    Buffer.from(headerB64 + '.' + payloadB64, 'ascii'),
    { key: pair.publicKeyPem, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureB64, 'base64url'),
  ), true);
}

test('status polling signs the exact status path with the enrolled device key', async () => {
  const pair = generateDeviceKeyPair();
  const transitions = [];
  let request;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test/',
    getAgentToken: () => TOKEN,
    getDeviceId: () => DEVICE_ID,
    getTenantId: () => TENANT_ID,
    getPrivateKeyPem: () => pair.privateKeyPem,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, {
        deviceId: DEVICE_ID,
        tenantId: TENANT_ID,
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
  assert.equal(result.tenantId, TENANT_ID);
  assert.equal(request.url, 'https://sync.example.test/api/v1/devices/status');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(request.options.headers['x-device-id'], DEVICE_ID);
  verifyStatusProof(request, pair);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].approvalStatus, 'approved');
});

test('pending, rejected and revoked are reported as distinct proof-authenticated server states', async () => {
  for (const approvalStatus of ['pending_approval', 'rejected', 'revoked']) {
    const pair = generateDeviceKeyPair();
    let observed;
    const service = new DeviceStatusService({
      baseUrl: 'https://sync.example.test',
      getAgentToken: () => TOKEN,
      getDeviceId: () => DEVICE_ID,
      getTenantId: () => TENANT_ID,
      getPrivateKeyPem: () => pair.privateKeyPem,
      fetchImpl: async (url, options) => {
        verifyStatusProof({ url, options }, pair);
        return response(200, {
          deviceId: DEVICE_ID,
          tenantId: TENANT_ID,
          approvalStatus,
          isActive: approvalStatus !== 'revoked',
          hasActiveCredential: approvalStatus !== 'revoked',
        });
      },
      onStatus: (status) => { observed = status; },
    });
    const result = await service.checkStatus();
    assert.equal(result.success, true);
    assert.equal(observed.approvalStatus, approvalStatus);
    assert.equal(observed.tenantId, TENANT_ID);
  }
});

test('network and server refusals preserve state by never calling transition callback', async () => {
  const pair = generateDeviceKeyPair();
  for (const fetchImpl of [
    async () => { throw new Error('network unavailable'); },
    async () => response(403, { code: 'DEVICE_PENDING_APPROVAL', message: 'Pending' }),
  ]) {
    let transitions = 0;
    const failures = [];
    const service = new DeviceStatusService({
      baseUrl: 'https://sync.example.test',
      getAgentToken: () => TOKEN,
      getDeviceId: () => DEVICE_ID,
      getTenantId: () => TENANT_ID,
      getPrivateKeyPem: () => pair.privateKeyPem,
      fetchImpl,
      onStatus: () => { transitions += 1; },
      onVerificationFailure: (failure) => failures.push(failure),
    });
    const result = await service.checkStatus();
    assert.equal(result.success, false);
    assert.equal(transitions, 0);
    assert.equal(failures.length, 1);
    assert.ok(['NETWORK_ERROR', 'HTTP_REFUSAL'].includes(failures[0].reason));
  }
});

test('rejects a status response bound to another tenant without changing trust state', async () => {
  const pair = generateDeviceKeyPair();
  let transitions = 0;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => TOKEN,
    getDeviceId: () => DEVICE_ID,
    getTenantId: () => TENANT_ID,
    getPrivateKeyPem: () => pair.privateKeyPem,
    fetchImpl: async () => response(200, {
      deviceId: DEVICE_ID,
      tenantId: '00000000-0000-4000-8000-000000000999',
      approvalStatus: 'approved', isActive: true, hasActiveCredential: true,
    }),
    onStatus: () => { transitions += 1; },
  });
  const result = await service.checkStatus();
  assert.equal(result.success, false);
  assert.match(result.error, /expected server contract/);
  assert.equal(transitions, 0);
});

test('refuses to query status without the enrolled private key', async () => {
  let calls = 0;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => TOKEN,
    getDeviceId: () => DEVICE_ID,
    getPrivateKeyPem: () => null,
    fetchImpl: async () => { calls += 1; return response(200, {}); },
  });
  const result = await service.checkStatus();
  assert.equal(result.success, false);
  assert.equal(result.reason, 'LOCAL_CREDENTIAL_INVALID');
  assert.equal(calls, 0);
});

test('reports invalid server contracts as retry-required without a trust transition', async () => {
  const pair = generateDeviceKeyPair();
  let transitions = 0;
  let failure;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => TOKEN,
    getDeviceId: () => DEVICE_ID,
    getTenantId: () => TENANT_ID,
    getPrivateKeyPem: () => pair.privateKeyPem,
    fetchImpl: async () => response(200, {
      deviceId: DEVICE_ID, tenantId: '00000000-0000-4000-8000-000000000999',
      approvalStatus: 'approved', isActive: true, hasActiveCredential: true,
    }),
    onStatus: () => { transitions += 1; },
    onVerificationFailure: (value) => { failure = value; },
  });
  const result = await service.checkStatus();
  assert.equal(result.success, false);
  assert.equal(result.reason, 'INVALID_RESPONSE');
  assert.equal(failure.reason, 'INVALID_RESPONSE');
  assert.equal(transitions, 0);
});

test('distinguishes absent local proof material from a network verification failure', async () => {
  let failure;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => TOKEN,
    getDeviceId: () => DEVICE_ID,
    getTenantId: () => TENANT_ID,
    getPrivateKeyPem: () => null,
    onVerificationFailure: (value) => { failure = value; },
    fetchImpl: async () => { throw new Error('must not perform network request'); },
  });
  const result = await service.checkStatus();
  assert.equal(result.reason, 'LOCAL_CREDENTIAL_INVALID');
  assert.equal(failure.reason, 'LOCAL_CREDENTIAL_INVALID');
});

test('network loss sets retry-required while preserving confirmed approval and pending local outbox', async () => {
  const pair = generateDeviceKeyPair();
  let deviceTrustState = 'approved';
  let verificationState = 'verified';
  const outbox = [{ id: 'sale-001', status: 'pending', amountMinor: 12500 }];
  const before = structuredClone(outbox);
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => TOKEN,
    getDeviceId: () => DEVICE_ID,
    getTenantId: () => TENANT_ID,
    getPrivateKeyPem: () => pair.privateKeyPem,
    fetchImpl: async () => { throw new Error('network unavailable'); },
    onStatus: () => { throw new Error('failed verification must not transition trust'); },
    onVerificationFailure: () => { verificationState = 'RETRY_REQUIRED'; },
  });
  const result = await service.checkStatus();
  assert.equal(result.reason, 'NETWORK_ERROR');
  assert.equal(verificationState, 'RETRY_REQUIRED');
  assert.equal(deviceTrustState, 'approved');
  assert.equal(canAccessLocalPOS('authenticated', deviceTrustState), true);
  assert.deepEqual(outbox, before);
});

test('classifies request timeout separately from other network failures', async () => {
  const pair = generateDeviceKeyPair();
  let failure;
  const service = new DeviceStatusService({
    baseUrl: 'https://sync.example.test',
    getAgentToken: () => TOKEN,
    getDeviceId: () => DEVICE_ID,
    getTenantId: () => TENANT_ID,
    getPrivateKeyPem: () => pair.privateKeyPem,
    fetchImpl: async () => {
      const error = new Error('request timed out');
      error.name = 'TimeoutError';
      throw error;
    },
    onVerificationFailure: (value) => { failure = value; },
  });
  const result = await service.checkStatus();
  assert.equal(result.reason, 'NETWORK_TIMEOUT');
  assert.equal(failure.reason, 'NETWORK_TIMEOUT');
});
