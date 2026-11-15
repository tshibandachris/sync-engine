'use strict';

const { pushChanges, closeCashSession } = require('./api-client.cjs');
const { preparePushBatch, applyPushResponse } = require('./outbox.cjs');

/**
 * Push one persisted Outbox batch and acknowledge it only after the server
 * response has passed the API client's success and payload-contract checks.
 * A rejected HTTP request or network error exits before applyPushResponse,
 * leaving the batch and its idempotency key available for an exact retry.
 */
async function pushPendingBatch({
  db,
  baseUrl,
  token,
  deviceId,
  privateKeyPem,
  fetchImpl,
}) {
  const batch = preparePushBatch(db);
  if (!batch) return { sent: false, acknowledged: 0, retained: 0 };

  const response = await pushChanges({
    baseUrl,
    token,
    deviceId,
    privateKeyPem,
    idempotencyKey: batch.idempotencyKey,
    payload: batch.payload,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const result = applyPushResponse(db, batch, response);
  return { sent: true, ...result };
}

async function closePendingCashSessions({ db, baseUrl, token, deviceId, privateKeyPem, fetchImpl }) {
  const pending = db.prepare(`
    SELECT id, close_closing_amount AS closingAmount, close_notes AS notes
    FROM cash_sessions WHERE status = 'open' AND close_requested_at IS NOT NULL
      AND close_sync_state = 'pending' ORDER BY close_requested_at, id LIMIT 50
  `).all();
  let closed = 0; let retained = 0;
  for (const session of pending) {
    const openSessionOutbox = db.prepare("SELECT 1 FROM outbox WHERE entity_type = 'cash_sessions' AND entity_id = ?").get(session.id);
    const pendingSales = db.prepare("SELECT payload_json FROM outbox WHERE entity_type = 'sales'").all();
    const hasPendingSale = pendingSales.some((row) => { try { return JSON.parse(row.payload_json).cash_session_id === session.id; } catch { return true; } });
    if (openSessionOutbox || hasPendingSale) { retained++; continue; }
    try {
      const response = await closeCashSession({ baseUrl, token, deviceId, privateKeyPem, cashSessionId: session.id, closingAmount: Number(session.closingAmount), notes: session.notes, ...(fetchImpl ? { fetchImpl } : {}) });
      if (!response || response.id !== session.id || response.status !== 'closed' || response.closingAmount !== Number(session.closingAmount) || !Number.isSafeInteger(response.closedAt) || !Number.isSafeInteger(response.expectedAmount) || !Number.isSafeInteger(response.difference)) throw new Error('Cash-session close response does not match the local request.');
      db.prepare(`UPDATE cash_sessions SET status = 'closed', closed_at = ?, closing_amount = ?, expected_amount = ?, difference = ?, notes = ?, last_known_sync_seq = ?, close_sync_state = 'completed', close_sync_error = NULL WHERE id = ? AND close_requested_at IS NOT NULL AND status = 'open'`).run(response.closedAt, response.closingAmount, response.expectedAmount, response.difference, response.notes ?? session.notes, Number.isSafeInteger(response.syncSeq) ? response.syncSeq : 0, session.id);
      closed++;
    } catch (error) {
      db.prepare('UPDATE cash_sessions SET close_sync_error = ? WHERE id = ?').run(String(error.message || 'Close request failed').slice(0, 1000), session.id);
      retained++;
    }
  }
  return { closed, retained };
}

module.exports = { pushPendingBatch, closePendingCashSessions };
