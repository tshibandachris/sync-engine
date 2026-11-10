'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateDeviceKeyPair } = require('../electron/auth/device-crypto.cjs');
const { pullChanges, pushChanges } = require('../electron/sync/api-client.cjs');

const DEVICE_ID = '00000000-0000-4000-8000-000000000111';
const TOKEN = 'agent.jwt.token';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function verifyRequestProof(request, pair, expectedPath) {
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.options.headers['x-device-id'], DEVICE_ID);
  const proof = request.options.headers['x-device-proof'];
  assert.equal(typeof proof, 'string');
  const [headerB64, payloadB64, signatureB64] = proof.split('.');
  assert.equal(proof.split('.').length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')), {
    alg: 'ES256',
    typ: 'dpop+jwt',
  });
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, expectedPath);
  assert.equal(payload.ath, crypto.createHash('sha256').update(TOKEN).digest('base64url'));
  assert.match(payload.jti, /^[0-9a-f-]{36}$/i);
  assert.equal(Buffer.from(signatureB64, 'base64url').length, 64);
  assert.equal(crypto.verify(
    'sha256',
    Buffer.from(headerB64 + '.' + payloadB64, 'ascii'),
    { key: pair.publicKeyPem, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureB64, 'base64url'),
  ), true);
  return payload;
}

test('pull signs the exact sync path and binds the bearer token to the registered device', async () => {
  const pair = generateDeviceKeyPair();
  let request;
  const result = await pullChanges({
    baseUrl: 'https://sync.example.test/',
    token: TOKEN,
    deviceId: DEVICE_ID,
    privateKeyPem: pair.privateKeyPem,
    lastPulledAt: 12,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { timestamp: 13, changes: {}, has_more: false });
    },
  });

  assert.equal(request.url, 'https://sync.example.test/sync/pull');
  const payload = verifyRequestProof(request, pair, '/sync/pull');
  assert.equal(typeof payload.iat, 'number');
  assert.deepEqual(JSON.parse(request.options.body), { last_pulled_at: 12, limit: 1000 });
  assert.deepEqual(result, { timestamp: 13, changes: {}, has_more: false });
});

test('push signs the request while preserving the persisted idempotency key and payload', async () => {
  const pair = generateDeviceKeyPair();
  let request;
  const payload = { changes: { sales: [{ id: 'sale-1' }] } };
  const result = await pushChanges({
    baseUrl: 'https://sync.example.test',
    token: TOKEN,
    deviceId: DEVICE_ID,
    privateKeyPem: pair.privateKeyPem,
    idempotencyKey: 'persisted-batch-uuid',
    payload,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { applied: { sales: 1 }, conflicts: [] });
    },
  });

  assert.equal(request.url, 'https://sync.example.test/sync/push');
  verifyRequestProof(request, pair, '/sync/push');
  assert.equal(request.options.headers['Idempotency-Key'], 'persisted-batch-uuid');
  assert.deepEqual(JSON.parse(request.options.body), payload);
  assert.deepEqual(result, { applied: { sales: 1 }, conflicts: [] });
});

test('refuses unsigned sync before making a network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(200, {}); };
  await assert.rejects(
    pullChanges({ baseUrl: 'https://sync.example.test', token: TOKEN, fetchImpl }),
    /registered device ID/,
  );
  await assert.rejects(
    pullChanges({ baseUrl: 'https://sync.example.test', token: TOKEN, deviceId: DEVICE_ID, fetchImpl }),
    /encrypted ES256 private key/,
  );
  assert.equal(calls, 0);
});
