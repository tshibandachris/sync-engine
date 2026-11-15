const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('../electron/db/client.cjs');
const { openCashSession, requestCashSessionClose } = require('../electron/db/pos.cjs');
const { closePendingCashSessions } = require('../electron/sync/sync-coordinator.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-cash-close-'));
  const db = openDatabase({ getPath: () => root });
  const staffId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO staff (id, display_name, role, is_active, created_at, updated_at)
    VALUES (?, 'Caissier', 'cashier', 1, 100, 100)
  `).run(staffId);
  const session = openCashSession(db, { staffId, openingAmount: 1000 }, 1000);
  requestCashSessionClose(db, { cashSessionId: session.id, closingAmount: 1000 }, 2000);
  return {
    db, session,
    cleanup() { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function keyPair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

test('sends the close request with ES256 device proof and marks the session closed only after confirmation', async () => {
  const f = fixture();
  try {
    f.db.prepare("DELETE FROM outbox WHERE entity_type = 'cash_sessions' AND entity_id = ?").run(f.session.id);
    const { privateKey } = keyPair();
    const deviceId = crypto.randomUUID();
    let captured;
    const result = await closePendingCashSessions({
      db: f.db,
      baseUrl: 'http://127.0.0.1:3000',
      token: 'test-agent-jwt',
      deviceId,
      privateKeyPem: privateKey,
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            id: f.session.id,
            status: 'closed',
            closedAt: 3000,
            closingAmount: 1000,
            expectedAmount: 1000,
            difference: 0,
            notes: null,
            syncSeq: 7,
          }),
        };
      },
    });
    assert.deepEqual(result, { closed: 1, retained: 0 });
    assert.equal(captured.url, 'http://127.0.0.1:3000/cash-sessions/' + f.session.id + '/close');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers['x-device-id'], deviceId);
    assert.match(captured.options.headers['x-device-proof'], /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(JSON.parse(captured.options.body), { closingAmount: 1000 });
    const row = f.db.prepare('SELECT status, closed_at, closing_amount, expected_amount, difference, close_sync_state FROM cash_sessions WHERE id = ?').get(f.session.id);
    assert.deepEqual(row, {
      status: 'closed', closed_at: 3000, closing_amount: 1000,
      expected_amount: 1000, difference: 0, close_sync_state: 'completed',
    });
  } finally {
    f.cleanup();
  }
});

test('does not close a session while any sale for it remains in the outbox', async () => {
  const f = fixture();
  try {
    f.db.prepare("DELETE FROM outbox WHERE entity_type = 'cash_sessions' AND entity_id = ?").run(f.session.id);
    f.db.prepare("INSERT INTO outbox(entity_type, entity_id, operation, payload_json, created_at) VALUES ('sales', ?, 'create', ?, 2500)")
      .run(crypto.randomUUID(), JSON.stringify({ id: crypto.randomUUID(), cash_session_id: f.session.id }));
    let fetchCalls = 0;
    const result = await closePendingCashSessions({
      db: f.db, baseUrl: 'http://127.0.0.1:3000', token: 'test-agent-jwt',
      deviceId: crypto.randomUUID(), privateKeyPem: keyPair().privateKey,
      fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
    });
    assert.deepEqual(result, { closed: 0, retained: 1 });
    assert.equal(fetchCalls, 0);
    assert.equal(f.db.prepare('SELECT status FROM cash_sessions WHERE id = ?').get(f.session.id).status, 'open');
  } finally {
    f.cleanup();
  }
});

test('retains a close request and records the failure when the server is unavailable', async () => {
  const f = fixture();
  try {
    f.db.prepare("DELETE FROM outbox WHERE entity_type = 'cash_sessions' AND entity_id = ?").run(f.session.id);
    const result = await closePendingCashSessions({
      db: f.db, baseUrl: 'http://127.0.0.1:3000', token: 'test-agent-jwt',
      deviceId: crypto.randomUUID(), privateKeyPem: keyPair().privateKey,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ code: 'UNAVAILABLE' }) }),
    });
    assert.deepEqual(result, { closed: 0, retained: 1 });
    const row = f.db.prepare('SELECT status, close_sync_state, close_sync_error FROM cash_sessions WHERE id = ?').get(f.session.id);
    assert.equal(row.status, 'open');
    assert.equal(row.close_sync_state, 'pending');
    assert.match(row.close_sync_error, /UNAVAILABLE/);
  } finally {
    f.cleanup();
  }
});
