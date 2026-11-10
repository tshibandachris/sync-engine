'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pullChanges, pushChanges } = require('../electron/sync/api-client.cjs');
const { generateDeviceKeyPair } = require('../electron/auth/device-crypto.cjs');

const TOKEN = 'test-agent-jwt-bound-to-device-proof';
const DEVICE_ID = '00000000-0000-4000-8000-000000000201';

function createCredential() {
  const pair = generateDeviceKeyPair();
  return {
    deviceId: DEVICE_ID,
    privateKeyPem: pair.privateKeyPem,
    publicKeyPem: pair.publicKeyPem,
    thumbprint: pair.thumbprint,
    algorithm: 'ES256',
  };
}

function verifyRequestProof(options, credential, expectedPath) {
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(options.headers['x-device-id'], DEVICE_ID);
  const proof = options.headers['x-device-proof'];
  assert.equal(typeof proof, 'string');
  assert.ok(proof.length > 0 && proof.length < 8192);

  const segments = proof.split('.');
  assert.equal(segments.length, 3);
  const [headerB64, payloadB64, signatureB64] = segments;
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const signature = Buffer.from(signatureB64, 'base64url');

  assert.deepEqual(header, { alg: 'ES256', typ: 'dpop+jwt' });
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, expectedPath);
  assert.equal(payload.ath, crypto.createHash('sha256').update(TOKEN, 'utf8').digest('base64url'));
  assert.match(payload.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - payload.iat) <= 60);
  assert.equal(signature.length, 64);
  assert.equal(
    crypto.verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
      { key: credential.publicKeyPem, dsaEncoding: 'ieee-p1363' },
      signature,
    ),
    true,
  );
  return payload;
}

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('pull signs each request with the device key and exact server path contract', async () => {
  const credential = createCredential();
  let captured;
  const result = await pullChanges({
    baseUrl: 'https://sync.example.test/',
    token: TOKEN,
    deviceCredential: credential,
    lastPulledAt: 123,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return fakeResponse({ timestamp: 124, has_more: false, changes: {} });
    },
  });

  assert.equal(captured.url, 'https://sync.example.test/sync/pull');
  const proof = verifyRequestProof(captured.options, credential, '/sync/pull');
  assert.equal(result.timestamp, 124);
  assert.deepEqual(JSON.parse(captured.options.body), { last_pulled_at: 123, limit: 1000 });
  assert.equal(JSON.stringify(captured.options.body).includes(credential.privateKeyPem), false);
  assert.ok(proof.jti);
});

test('push signs each retry freshly and preserves the durable idempotency key', async () => {
  const credential = createCredential();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return fakeResponse({ applied: { created: 1, updated: 0, deleted: 0 }, conflicts: [] });
  };
  const payload = { changes: { products: [{ id: 'p-1', name: 'Cahier', price: 500 }] } };

  await pushChanges({
    baseUrl: 'https://sync.example.test',
    token: TOKEN,
    deviceCredential: credential,
    idempotencyKey: 'persisted-batch-uuid',
    payload,
    fetchImpl,
  });
  await pushChanges({
    baseUrl: 'https://sync.example.test',
    token: TOKEN,
    deviceCredential: credential,
    idempotencyKey: 'persisted-batch-uuid',
    payload,
    fetchImpl,
  });

  assert.equal(requests.length, 2);
  const first = verifyRequestProof(requests[0].options, credential, '/sync/push');
  const second = verifyRequestProof(requests[1].options, credential, '/sync/push');
  assert.notEqual(first.jti, second.jti, 'each HTTP attempt must consume a fresh proof nonce');
  for (const request of requests) {
    assert.equal(request.url, 'https://sync.example.test/sync/push');
    assert.equal(request.options.headers['Idempotency-Key'], 'persisted-batch-uuid');
    assert.equal(JSON.parse(request.options.body).changes.products[0].id, 'p-1');
    assert.equal(request.options.body.includes(credential.privateKeyPem), false);
  }
});

test('refuses sync before a verified device credential is available', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not send'); };
  await assert.rejects(
    pullChanges({ baseUrl: 'https://sync.example.test', token: TOKEN, fetchImpl }),
    /verified ES256 device credential is required/i,
  );
  await assert.rejects(
    pushChanges({
      baseUrl: 'https://sync.example.test',
      token: TOKEN,
      deviceCredential: { deviceId: DEVICE_ID, privateKeyPem: 'not-a-key', algorithm: 'ES256' },
      idempotencyKey: 'batch-1',
      payload: { changes: {} },
      fetchImpl,
    }),
  );
  assert.equal(called, false);
});
