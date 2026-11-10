'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE_LENGTH = 64;

function assertPem(value, label, marker) {
  if (typeof value !== 'string' || !value.includes(marker)) {
    throw new TypeError(label + ' must be a valid PEM-encoded key.');
  }
}

function exportPublicJwk(publicKeyPem) {
  assertPem(publicKeyPem, 'Public key', 'BEGIN PUBLIC KEY');
  const jwk = crypto.createPublicKey(publicKeyPem).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
      typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new TypeError('Device public key must be an EC P-256 key.');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

function calculateJwkThumbprint(publicKeyPem) {
  const jwk = exportPublicJwk(publicKeyPem);
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function assertKeyPair(privateKeyPem, publicKeyPem) {
  assertPem(privateKeyPem, 'Private key', 'BEGIN PRIVATE KEY');
  const challenge = crypto.randomBytes(32);
  const signature = crypto.sign('sha256', challenge, {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  });
  if (signature.length !== SIGNATURE_LENGTH ||
      !crypto.verify('sha256', challenge, {
        key: publicKeyPem,
        dsaEncoding: 'ieee-p1363',
      }, signature)) {
    throw new Error('Device private and public keys do not form a valid P-256 key pair.');
  }
}

function generateDeviceKeyPair() {
  const pair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  assertKeyPair(pair.privateKey, pair.publicKey);
  const publicJwk = exportPublicJwk(pair.publicKey);
  return Object.freeze({
    privateKeyPem: pair.privateKey,
    publicKeyPem: pair.publicKey,
    publicJwk,
    thumbprint: calculateJwkThumbprint(pair.publicKey),
    algorithm: 'ES256',
  });
}

function createDeviceProof({ privateKeyPem, token, method, url, nowMs = Date.now(), jti = crypto.randomUUID() }) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('A non-empty bearer token is required to bind the device proof.');
  }
  if (typeof method !== 'string' || !/^[A-Za-z]+$/.test(method)) {
    throw new TypeError('A valid HTTP method is required.');
  }
  if (typeof url !== 'string' || !url) throw new TypeError('A request URL is required.');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs must be a non-negative safe integer.');
  if (typeof jti !== 'string' || !UUID_RE.test(jti)) throw new TypeError('jti must be a UUID.');

  assertPem(privateKeyPem, 'Private key', 'BEGIN PRIVATE KEY');
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' &&
      !(parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname))) {
    throw new Error('Device proof requests must target HTTPS outside localhost development.');
  }

  const header = { alg: 'ES256', typ: 'dpop+jwt' };
  const payload = {
    jti,
    htm: method.toUpperCase(),
    htu: parsedUrl.pathname,
    iat: Math.floor(nowMs / 1000),
    ath: crypto.createHash('sha256').update(token, 'utf8').digest('base64url'),
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = headerB64 + '.' + payloadB64;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  });
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new Error('ES256 signer did not produce a 64-byte IEEE P1363 signature.');
  }
  return signingInput + '.' + signature.toString('base64url');
}


function createInitialEnrollmentProof({ privateKeyPem, activationCode, fingerprint, deviceId, nowMs = Date.now(), jti = crypto.randomUUID() }) {
  if (typeof activationCode !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(activationCode)) {
    throw new TypeError('A normalized activation code is required.');
  }
  if (typeof fingerprint !== 'string' || !fingerprint.trim() || fingerprint.length > 255) {
    throw new TypeError('A valid installation fingerprint is required.');
  }
  if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) {
    throw new TypeError('A valid device UUID is required.');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs must be a non-negative safe integer.');
  if (!UUID_RE.test(jti)) throw new TypeError('jti must be a UUID.');
  assertPem(privateKeyPem, 'Private key', 'BEGIN PRIVATE KEY');

  const header = { alg: 'ES256', typ: 'dpop+jwt' };
  const payload = {
    jti,
    htm: 'POST',
    htu: '/api/v1/devices/enroll',
    iat: Math.floor(nowMs / 1000),
    code_hash: crypto.createHash('sha256').update(activationCode, 'utf8').digest('base64url'),
    fingerprint,
    device_id: deviceId,
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = headerB64 + '.' + payloadB64;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  });
  if (signature.length !== SIGNATURE_LENGTH) throw new Error('ES256 signer did not produce a 64-byte IEEE P1363 signature.');
  return signingInput + '.' + signature.toString('base64url');
}

module.exports = {
  createInitialEnrollmentProof,
  SIGNATURE_LENGTH,
  assertKeyPair,
  calculateJwkThumbprint,
  createDeviceProof,
  exportPublicJwk,
  generateDeviceKeyPair,
};
