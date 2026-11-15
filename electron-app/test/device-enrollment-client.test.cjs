'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enrollDevice } = require('../electron/auth/device-enrollment-client.cjs');

const DEVICE_ID = '00000000-0000-4000-8000-000000000111';
const TENANT_ID = '00000000-0000-4000-8000-000000000222';
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000333';
const THUMBPRINT = 'Q'.repeat(43);

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const input = {
  baseUrl: 'https://sync.example.test/',
  activationCode: 'ABCD-1234',
  deviceName: 'Caisse principale',
  hardwareInfo: { hostname: 'pos-01', platform: 'win32', arch: 'x64', osRelease: '10.0' },
  fingerprint: 'a'.repeat(64),
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----',
  initialProof: 'header.payload.signature',
  expectedThumbprint: THUMBPRINT,
};

test('posts the initial proof without exposing the private key or agent token', async () => {
  let request;
  const result = await enrollDevice({
    ...input,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(201, { success: true, data: {
        deviceId: DEVICE_ID, tenantId: TENANT_ID, credentialId: CREDENTIAL_ID,
        approvalStatus: 'pending_approval', keyThumbprint: THUMBPRINT,
      } });
    },
  });
  assert.equal(request.url, 'https://sync.example.test/api/v1/devices/enroll');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['x-device-fingerprint'], input.fingerprint);
  assert.equal(request.options.headers.authorization, undefined);
  const body = JSON.parse(request.options.body);
  assert.equal(body.activationCode, input.activationCode);
  assert.equal(body.deviceName, input.deviceName);
  assert.equal(body.publicKeyPem, input.publicKeyPem);
  assert.equal(body.initialProof, input.initialProof);
  assert.equal('privateKeyPem' in body, false);
  assert.deepEqual(result, {
    deviceId: DEVICE_ID, tenantId: TENANT_ID, credentialId: CREDENTIAL_ID,
    approvalStatus: 'pending_approval', keyThumbprint: THUMBPRINT,
  });
});

test('rejects server errors with their structured code', async () => {
  await assert.rejects(
    enrollDevice({ ...input, fetchImpl: async () => response(401, {
      code: 'INVALID_ACTIVATION_CODE', message: 'Code invalide.',
    }) }),
    (error) => error.status === 401 && error.code === 'INVALID_ACTIVATION_CODE',
  );
});

test('rejects a successful response that does not bind the expected key thumbprint', async () => {
  await assert.rejects(
    enrollDevice({ ...input, fetchImpl: async () => response(201, { success: true, data: {
      deviceId: DEVICE_ID, tenantId: TENANT_ID, credentialId: CREDENTIAL_ID,
      approvalStatus: 'pending_approval', keyThumbprint: 'wrong',
    } }) }),
    /expected server contract/,
  );
});

test('rejects non-HTTPS API URLs outside localhost', async () => {
  await assert.rejects(enrollDevice({ ...input, baseUrl: 'http://sync.example.test' }), /HTTPS/);
});
