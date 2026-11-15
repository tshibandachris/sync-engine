'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_STATES = new Set(['pending_approval', 'approved', 'rejected', 'revoked']);

function normalizeBaseUrl(value) {
  if (!value) throw new Error('EDEN_SYNC_URL is required.');
  const url = new URL(value);
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('EDEN_SYNC_URL must use HTTPS outside localhost development.');
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Sends the signed initial proof from Electron Main. The private key and agent
 * token are never serialized into the enrollment request or returned to Renderer.
 */
async function enrollDevice({
  baseUrl,
  activationCode,
  deviceName,
  hardwareInfo,
  fingerprint,
  publicKeyPem,
  initialProof,
  expectedThumbprint,
  fetchImpl = fetch,
  timeoutMs = 15000,
}) {
  if (typeof activationCode !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(activationCode)) {
    throw new TypeError('Activation code must use the XXXX-XXXX format.');
  }
  if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.trim().length > 120) {
    throw new TypeError('Device name must contain 1 to 120 characters.');
  }
  if (!hardwareInfo || typeof hardwareInfo !== 'object' || Array.isArray(hardwareInfo)) {
    throw new TypeError('Hardware information is required.');
  }
  if (typeof fingerprint !== 'string' || !fingerprint.trim() || fingerprint.length > 255) {
    throw new TypeError('A valid device fingerprint is required.');
  }
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new TypeError('A SPKI public key is required.');
  }
  if (typeof initialProof !== 'string' || !initialProof || initialProof.length > 8192) {
    throw new TypeError('An initial proof is required.');
  }

  const base = normalizeBaseUrl(baseUrl);
  const response = await fetchImpl(`${base}/api/v1/devices/enroll`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-device-fingerprint': fingerprint,
    },
    body: JSON.stringify({
      activationCode,
      deviceName: deviceName.trim(),
      hardwareInfo,
      publicKeyPem,
      initialProof,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`Device enrollment API returned invalid JSON (HTTP ${response.status}).`); }

  if (!response.ok) {
    const error = new Error(body?.message || body?.code || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.code || null;
    throw error;
  }

  const data = body?.data;
  if (body?.success !== true || !data ||
      !UUID_RE.test(data.deviceId || '') ||
      !UUID_RE.test(data.tenantId || '') ||
      !UUID_RE.test(data.credentialId || '') ||
      !APPROVAL_STATES.has(data.approvalStatus) ||
      data.keyThumbprint !== expectedThumbprint) {
    throw new Error('Enrollment response does not match the expected server contract.');
  }

  return {
    deviceId: data.deviceId,
    tenantId: data.tenantId,
    credentialId: data.credentialId,
    approvalStatus: data.approvalStatus,
    keyThumbprint: data.keyThumbprint,
  };
}

module.exports = { enrollDevice, normalizeBaseUrl };
