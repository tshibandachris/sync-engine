const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { enrollDevice, getDeviceStatus, pullChanges, pushChanges } = require('../electron/sync/api-client.cjs');
const { generateDeviceKeyPair } = require('../electron/auth/device-crypto.cjs');

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) };
}

function verifyProof(proof, publicKeyPem) {
  const [headerB64, payloadB64, signatureB64] = proof.split('.');
  const signature = Buffer.from(signatureB64, 'base64url');
  assert.equal(signature.length, 64);
  assert.equal(crypto.verify('sha256', Buffer.from(headerB64 + '.' + payloadB64, 'ascii'), {
    key: publicKeyPem, dsaEncoding: 'ieee-p1363',
  }, signature), true);
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
}

test('enrollment sends agent JWT, fingerprint header, public key and initial proof', async () => {
  const pair = generateDeviceKeyPair();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ success: true, data: {
      deviceId: 'e1d9f9c3-a8f0-4b8e-9eaf-70cc7b66c1a3',
      tenantId: 'd2d0d6c2-84a2-4a83-9f70-1c4a99f2b7a1',
      approvalStatus: 'pending_approval',
    } }, 201);
  };
  const data = await enrollDevice({
    baseUrl: 'https://api.example.test',
    token: 'agent.jwt.token',
    activationCode: 'ED26-89AB',
    deviceId: 'e1d9f9c3-a8f0-4b8e-9eaf-70cc7b66c1a3',
    deviceName: 'Caisse principale',
    fingerprint: 'a'.repeat(64),
    hardwareInfo: { hostname: 'POS-01', platform: 'win32', arch: 'x64' },
    publicKeyPem: pair.publicKeyPem,
    initialProof: 'header.payload.signature',
    fetchImpl,
  });
  assert.equal(data.approvalStatus, 'pending_approval');
  assert.equal(calls[0].url, 'https://api.example.test/api/v1/devices/enroll');
  assert.equal(calls[0].options.headers.authorization, 'Bearer agent.jwt.token');
  assert.equal(calls[0].options.headers['X-Device-Fingerprint'], 'a'.repeat(64));
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.publicKeyPem, pair.publicKeyPem);
  assert.equal(body.deviceId, 'e1d9f9c3-a8f0-4b8e-9eaf-70cc7b66c1a3');
});

test('approval status is queried with the agent JWT and device ID without a device proof', async () => {
  let captured;
  const status = await getDeviceStatus({
    baseUrl: 'https://api.example.test',
    token: 'agent.jwt.token',
    deviceId: 'e1d9f9c3-a8f0-4b8e-9eaf-70cc7b66c1a3',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response({ deviceId: options.headers['X-Device-Id'], tenantId: 'd2d0d6c2-84a2-4a83-9f70-1c4a99f2b7a1', approvalStatus: 'approved', isActive: true });
    },
  });
  assert.equal(status.approvalStatus, 'approved');
  assert.equal(captured.options.headers['X-Device-Id'], status.deviceId);
  assert.equal(captured.options.headers['X-Device-Proof'], undefined);
});

test('sync pull signs each request and binds the proof to the bearer token and route', async () => {
  const pair = generateDeviceKeyPair();
  let captured;
  await pullChanges({
    baseUrl: 'https://api.example.test',
    token: 'agent.jwt.token',
    deviceId: 'e1d9f9c3-a8f0-4b8e-9eaf-70cc7b66c1a3',
    privateKeyPem: pair.privateKeyPem,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response({ timestamp: 10, changes: {}, has_more: false });
    },
  });
  const payload = verifyProof(captured.options.headers['X-Device-Proof'], pair.publicKeyPem);
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, '/sync/pull');
  assert.equal(payload.ath, crypto.createHash('sha256').update('agent.jwt.token').digest('base64url'));
  assert.equal(captured.options.headers['X-Device-Id'], 'e1d9f9c3-a8f0-4b8e-9eaf-70cc7b66c1a3');
});

test('sync push signs the push route and retains the idempotency key', async () => {
  const pair = generateDeviceKeyPair();
  let captured;
  await pushChanges({
    baseUrl: 'https://api.example.test',
    token: 'agent.jwt.token',
    deviceId: 'e1d9f9c3-a8f0-4b8e-9eaf-70cc7b66c1a3',
    privateKeyPem: pair.privateKeyPem,
    idempotencyKey: 'idempotency-1',
    payload: { changes: {} },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response({ applied: {}, conflicts: [] });
    },
  });
  const payload = verifyProof(captured.options.headers['X-Device-Proof'], pair.publicKeyPem);
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, '/sync/push');
  assert.equal(captured.options.headers['Idempotency-Key'], 'idempotency-1');
});

test('sync refuses to send requests without a registered device key', async () => {
  await assert.rejects(pullChanges({
    baseUrl: 'https://api.example.test',
    token: 'agent.jwt.token',
    fetchImpl: async () => { throw new Error('must not be called'); },
  }), /approved device credential/);
});
