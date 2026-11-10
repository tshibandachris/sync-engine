const { createDeviceProof } = require('../auth/device-crypto.cjs');

function normalizeBaseUrl(value) {
  if (!value) throw new Error('EDEN_SYNC_URL is required (base URL of the NestJS API).');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('EDEN_SYNC_URL must use HTTPS outside localhost development.');
  }
  return url.toString().replace(/\/$/, '');
}

async function parseResponse(response, label) {
  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(label + ' API returned invalid JSON (HTTP ' + response.status + ').'); }
  if (!response.ok) {
    const code = parsed?.code || parsed?.error || 'HTTP ' + response.status;
    const error = new Error(label + ' failed: ' + code + (parsed?.message ? ' — ' + parsed.message : ''));
    error.status = response.status;
    error.code = parsed?.code || parsed?.error || null;
    throw error;
  }
  return parsed;
}

async function requestJson({ url, token, body, headers = {}, deviceId, privateKeyPem, fetchImpl = fetch, timeoutMs = 15000, label }) {
  if (!token) throw new Error('An agent bearer JWT must be loaded from secure device storage before synchronization.');
  if (typeof deviceId !== 'string' || !deviceId || typeof privateKeyPem !== 'string' || !privateKeyPem) {
    throw new Error('An approved device credential is required before synchronization.');
  }
  const proof = createDeviceProof({ privateKeyPem, token, method: 'POST', url });
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Device-Id': deviceId,
      'X-Device-Proof': proof,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseResponse(response, label);
}

async function enrollDevice({
  baseUrl, token, activationCode, deviceId, deviceName, fingerprint,
  hardwareInfo, publicKeyPem, initialProof, fetchImpl = fetch, timeoutMs = 15000,
}) {
  if (!token) throw new Error('Le JWT de l’agent est requis pour rattacher le terminal à son tenant.');
  const base = normalizeBaseUrl(baseUrl);
  const response = await fetchImpl(base + '/api/v1/devices/enroll', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Device-Fingerprint': fingerprint,
    },
    body: JSON.stringify({
      activationCode, deviceId, deviceName, fingerprint, hardwareInfo, publicKeyPem, initialProof,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = await parseResponse(response, 'Device enrollment');
  if (!parsed?.success || !parsed.data?.deviceId || !parsed.data?.tenantId ||
      parsed.data.approvalStatus !== 'pending_approval') {
    throw new Error('Enrollment API response does not match the pending-approval contract.');
  }
  return parsed.data;
}

async function getDeviceStatus({ baseUrl, token, deviceId, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!token || !deviceId) throw new Error('Agent token and device ID are required to check approval.');
  const base = normalizeBaseUrl(baseUrl);
  const response = await fetchImpl(base + '/api/v1/devices/status', {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json',
      'X-Device-Id': deviceId,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = await parseResponse(response, 'Device status');
  if (!parsed?.deviceId || !parsed?.approvalStatus) throw new Error('Device status response is invalid.');
  return parsed;
}

async function pullChanges({ baseUrl, token, deviceId, privateKeyPem, lastPulledAt = 0, fetchImpl = fetch }) {
  const base = normalizeBaseUrl(baseUrl);
  const body = await requestJson({
    url: base + '/sync/pull', token, deviceId, privateKeyPem, fetchImpl, label: 'Pull',
    body: { last_pulled_at: lastPulledAt, limit: 1000 },
  });
  if (!body || typeof body.timestamp !== 'number' || !body.changes || typeof body.changes !== 'object') {
    throw new Error('Sync API response does not match the expected pull contract.');
  }
  return body;
}

async function pushChanges({ baseUrl, token, deviceId, privateKeyPem, idempotencyKey, payload, fetchImpl = fetch }) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('A persisted Idempotency-Key is required for sync push.');
  if (!payload || typeof payload !== 'object' || !payload.changes || typeof payload.changes !== 'object') {
    throw new Error('Push payload does not match the expected sync contract.');
  }
  const base = normalizeBaseUrl(baseUrl);
  const body = await requestJson({
    url: base + '/sync/push', token, deviceId, privateKeyPem, fetchImpl, label: 'Push',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: payload,
  });
  if (!body || typeof body !== 'object' || !body.applied || !Array.isArray(body.conflicts)) {
    throw new Error('Sync API response does not match the expected push contract.');
  }
  return body;
}

module.exports = { pullChanges, pushChanges, normalizeBaseUrl, enrollDevice, getDeviceStatus };
