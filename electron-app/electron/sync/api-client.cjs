function normalizeBaseUrl(value) {
  if (!value) throw new Error('EDEN_SYNC_URL is required (base URL of the NestJS API).');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('EDEN_SYNC_URL must use HTTPS outside localhost development.');
  }
  return url.toString().replace(/\/$/, '');
}

async function pullChanges({ baseUrl, token, lastPulledAt = 0, fetchImpl = fetch }) {
  if (!token) throw new Error('EDEN_SYNC_TOKEN is required; no token is stored in source code.');
  const base = normalizeBaseUrl(baseUrl);
  const response = await fetchImpl(`${base}/sync/pull`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ last_pulled_at: lastPulledAt, limit: 1000 }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Sync API returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok) {
    const code = body?.code || body?.error || `HTTP ${response.status}`;
    throw new Error(`Pull failed: ${code}${body?.message ? ` — ${body.message}` : ''}`);
  }
  if (!body || typeof body.timestamp !== 'number' || !body.changes || typeof body.changes !== 'object') {
    throw new Error('Sync API response does not match the expected pull contract.');
  }
  return body;
}

module.exports = { pullChanges };
