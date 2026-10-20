function normalizeBaseUrl(value) {
  if (!value) throw new Error('EDEN_SYNC_URL is required (base URL of the NestJS API).');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('EDEN_SYNC_URL must use HTTPS outside localhost development.');
  }
  return url.toString().replace(/\/$/, '');
}

async function requestJson({ url, token, body, headers = {}, fetchImpl = fetch, timeoutMs = 15000, label }) {
  if (!token) throw new Error('EDEN_SYNC_TOKEN is required; no token is stored in source code.');
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

async function pullChanges({ baseUrl, token, lastPulledAt = 0, fetchImpl = fetch }) {
  const base = normalizeBaseUrl(baseUrl);
  const body = await requestJson({
    url: `${base}/sync/pull`, token, fetchImpl, label: 'Pull',
    body: { last_pulled_at: lastPulledAt, limit: 1000 },
  });
  if (!body || typeof body.timestamp !== 'number' || !body.changes || typeof body.changes !== 'object') {
    throw new Error('Sync API response does not match the expected pull contract.');
  }
  return body;
}

async function pushChanges({ baseUrl, token, idempotencyKey, payload, fetchImpl = fetch }) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw new Error('A persisted Idempotency-Key is required for sync push.');
  }
  if (!payload || typeof payload !== 'object' || !payload.changes || typeof payload.changes !== 'object') {
    throw new Error('Push payload does not match the expected sync contract.');
  }
  const base = normalizeBaseUrl(baseUrl);
  const body = await requestJson({
    url: `${base}/sync/push`, token, fetchImpl, label: 'Push',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: payload,
  });
  if (!body || typeof body !== 'object' || !body.applied || !Array.isArray(body.conflicts)) {
    throw new Error('Sync API response does not match the expected push contract.');
  }
  return body;
}

module.exports = { pullChanges, pushChanges, normalizeBaseUrl };
