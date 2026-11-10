const { createDeviceProof } = require('../auth/device-crypto.cjs');

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeBaseUrl(value) {
  if (!value) throw new Error('EDEN_SYNC_URL is required (base URL of the NestJS API).');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('EDEN_SYNC_URL must use HTTPS outside localhost development.');
  }
  return url.toString().replace(/\/$/, '');
}

async function requestJson({ url, token, body, headers = {}, fetchImpl = fetch, timeoutMs = 15000, label }) {
  if (!token) throw new Error('A device JWT must be loaded from secure device storage before synchronization.');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`Sync API returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok) {
    const code = parsed?.code || parsed?.error || `HTTP ${response.status}`;
    const error = new Error(`${label} failed: ${code}${parsed?.message ? ` — ${parsed.message}` : ''}`);
    error.status = response.status;
    error.code = parsed?.code || parsed?.error || null;
    error.responseBody = parsed;
    throw error;
  }
  return parsed;
}

function createProofHeaders({ baseUrl, path, token, deviceCredential }) {
  if (!deviceCredential || typeof deviceCredential !== 'object' ||
      !DEVICE_ID_RE.test(deviceCredential.deviceId || '') ||
      typeof deviceCredential.privateKeyPem !== 'string' ||
      deviceCredential.algorithm !== 'ES256') {
    throw new Error('A verified ES256 device credential is required for synchronization.');
  }
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;
  const proof = createDeviceProof({
    privateKeyPem: deviceCredential.privateKeyPem,
    token,
    method: 'POST',
    url,
  });
  return {
    'x-device-id': deviceCredential.deviceId,
    'x-device-proof': proof,
  };
}

async function pullChanges({ baseUrl, token, deviceCredential, lastPulledAt = 0, fetchImpl = fetch }) {
  const base = normalizeBaseUrl(baseUrl);
  const headers = createProofHeaders({ baseUrl: base, path: '/sync/pull', token, deviceCredential });
  const body = await requestJson({
    url: `${base}/sync/pull`, token, fetchImpl, label: 'Pull', headers,
    body: { last_pulled_at: lastPulledAt, limit: 1000 },
  });
  if (!body || typeof body.timestamp !== 'number' || !body.changes || typeof body.changes !== 'object') {
    throw new Error('Sync API response does not match the expected pull contract.');
  }
  return body;
}

async function pushChanges({ baseUrl, token, deviceCredential, idempotencyKey, payload, fetchImpl = fetch }) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw new Error('A persisted Idempotency-Key is required for sync push.');
  }
  if (!payload || typeof payload !== 'object' || !payload.changes || typeof payload.changes !== 'object') {
    throw new Error('Push payload does not match the expected sync contract.');
  }
  const base = normalizeBaseUrl(baseUrl);
  const proofHeaders = createProofHeaders({ baseUrl: base, path: '/sync/push', token, deviceCredential });
  const body = await requestJson({
    url: `${base}/sync/push`, token, fetchImpl, label: 'Push',
    headers: { ...proofHeaders, 'Idempotency-Key': idempotencyKey },
    body: payload,
  });
  if (!body || typeof body !== 'object' || !body.applied || !Array.isArray(body.conflicts)) {
    throw new Error('Sync API response does not match the expected push contract.');
  }
  return body;
}

module.exports = { pullChanges, pushChanges, normalizeBaseUrl };
