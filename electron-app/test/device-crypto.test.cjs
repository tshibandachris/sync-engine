const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  calculateJwkThumbprint,
  createDeviceProof,
  generateDeviceKeyPair,
} = require('../electron/auth/device-crypto.cjs');

function decode(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

test('generates a P-256 pair, exports RFC 7638 thumbprint, and signs a verifiable ES256 proof', () => {
  const pair = generateDeviceKeyPair();
  assert.equal(pair.algorithm, 'ES256');
  assert.equal(pair.thumbprint, calculateJwkThumbprint(pair.publicKeyPem));
  const proof = createDeviceProof({
    privateKeyPem: pair.privateKeyPem,
    token: 'agent.jwt.token',
    method: 'post',
    url: 'https://api.example.test/sync/pull?limit=100',
    nowMs: 1_800_000_000_000,
  });
  const [headerB64, payloadB64, signatureB64] = proof.split('.');
  const header = decode(headerB64);
  const payload = decode(payloadB64);
  assert.deepEqual(header, { alg: 'ES256', typ: 'dpop+jwt' });
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, '/sync/pull');
  assert.equal(payload.iat, 1_800_000_000);
  assert.equal(payload.ath, crypto.createHash('sha256').update('agent.jwt.token').digest('base64url'));
  assert.match(payload.jti, /^[0-9a-f-]{36}$/i);
  const signature = Buffer.from(signatureB64, 'base64url');
  assert.equal(signature.length, 64);
  assert.equal(crypto.verify('sha256', Buffer.from(headerB64 + '.' + payloadB64, 'ascii'), {
    key: pair.publicKeyPem, dsaEncoding: 'ieee-p1363',
  }, signature), true);
});

test('creates a fresh jti for each proof by default', () => {
  const pair = generateDeviceKeyPair();
  const args = { privateKeyPem: pair.privateKeyPem, token: 'a.b.c', method: 'POST', url: 'https://api.example.test/sync/push' };
  const first = decode(createDeviceProof(args).split('.')[1]);
  const second = decode(createDeviceProof(args).split('.')[1]);
  assert.notEqual(first.jti, second.jti);
});

test('rejects invalid inputs and insecure non-local URLs', () => {
  const pair = generateDeviceKeyPair();
  assert.throws(() => createDeviceProof({ privateKeyPem: pair.privateKeyPem, token: '', method: 'POST', url: 'https://api.test/sync/pull' }), /bearer token/);
  assert.throws(() => createDeviceProof({ privateKeyPem: pair.privateKeyPem, token: 'a.b.c', method: 'POST', url: 'http://api.test/sync/pull' }), /HTTPS/);
  assert.throws(() => createDeviceProof({ privateKeyPem: pair.privateKeyPem, token: 'a.b.c', method: 'POST', url: 'https://api.test/sync/pull', jti: 'bad' }), /UUID/);
});

test('rejects non-P-256 key material', () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => calculateJwkThumbprint(pair.publicKey.export({ type: 'spki', format: 'pem' })), /P-256/);
});
