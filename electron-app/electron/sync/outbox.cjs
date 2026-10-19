const { randomUUID } = require('node:crypto');

const SUPPORTED_TYPES = new Set(['products', 'staff', 'cash_sessions', 'sales']);

function ensureOutboxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox_batches (
      idempotency_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      outbox_ids_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      response_json TEXT,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_batches_state_created
      ON outbox_batches(state, created_at);
  `);
}

function enqueueOutbox(db, { entityType, entityId, operation, payload, now = Date.now() }) {
  ensureOutboxSchema(db);
  if (!SUPPORTED_TYPES.has(entityType)) throw new Error(`Unsupported outbox entity type: ${entityType}`);
  if (typeof entityId !== 'string' || !entityId.trim()) throw new Error('entityId must be a non-empty string');
  if (!['create', 'update', 'delete'].includes(operation)) throw new Error('Unsupported outbox operation');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');

  const normalized = { ...payload, id: entityId };
  if (operation === 'delete') {
    if (entityType === 'cash_sessions' || entityType === 'sales') {
      throw new Error(`Delete is not supported for ${entityType}; use the dedicated business workflow.`);
    }
    normalized.deletedAt = normalized.deletedAt ?? now;
  }

  db.prepare(`
    INSERT INTO outbox(entity_type, entity_id, operation, payload_json, created_at, attempts, last_error)
    VALUES (?, ?, ?, ?, ?, 0, NULL)
    ON CONFLICT(entity_type, entity_id, operation) DO UPDATE SET
      payload_json = excluded.payload_json,
      created_at = excluded.created_at,
      attempts = 0,
      last_error = NULL
  `).run(entityType, entityId, operation, JSON.stringify(normalized), now);
}

function buildChanges(rows) {
  const changes = { products: [], staff: [], cash_sessions: [], sales: [] };
  for (const row of rows) {
    if (!SUPPORTED_TYPES.has(row.entity_type)) {
      throw new Error(`Unsupported queued entity type: ${row.entity_type}`);
    }
    let payload;
    try { payload = JSON.parse(row.payload_json); }
    catch { throw new Error(`Invalid JSON in outbox row ${row.id}`); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.id !== row.entity_id) {
      throw new Error(`Invalid payload in outbox row ${row.id}`);
    }
    if (row.entity_type === 'products') {
      changes.products.push({
        id: payload.id, name: payload.name, sku: payload.sku ?? null,
        barcode: payload.barcode ?? null, category: payload.category ?? null,
        price: payload.price, cost: payload.cost ?? null,
        stockAlert: payload.stockAlert ?? payload.stock_alert ?? 5,
        isActive: payload.isActive ?? payload.is_active ?? true,
        ...((payload.createdAt ?? payload.created_at) === undefined ? {} : { createdAt: payload.createdAt ?? payload.created_at }),
        deletedAt: row.operation === 'delete' ? (payload.deletedAt ?? row.created_at) : (payload.deletedAt ?? null),
        lastKnownSyncSeq: payload.lastKnownSyncSeq ?? payload.last_known_sync_seq ?? payload.sync_seq ?? 0,
      });
    } else if (row.entity_type === 'staff') {
      changes.staff.push({
        id: payload.id, displayName: payload.displayName ?? payload.display_name,
        role: payload.role, isActive: payload.isActive ?? payload.is_active ?? true,
        ...((payload.createdAt ?? payload.created_at) === undefined ? {} : { createdAt: payload.createdAt ?? payload.created_at }),
        deletedAt: row.operation === 'delete' ? (payload.deletedAt ?? row.created_at) : (payload.deletedAt ?? null),
        lastKnownSyncSeq: payload.lastKnownSyncSeq ?? payload.last_known_sync_seq ?? payload.sync_seq ?? 0,
      });
    } else if (row.entity_type === 'cash_sessions') {
      if (row.operation === 'delete') throw new Error('Cash sessions cannot be deleted through sync push.');
      changes.cash_sessions.push(payload);
    } else {
      if (row.operation === 'delete') throw new Error('Sales cannot be deleted through sync push.');
      if (!Array.isArray(payload.lines) || payload.lines.length < 1 || !Array.isArray(payload.stock_movements)) {
        throw new Error(`Sale ${row.entity_id} must contain lines and stock_movements arrays.`);
      }
      changes.sales.push(payload);
    }
  }
  return changes;
}

function preparePushBatch(db, { limit = 100, now = Date.now() } = {}) {
  ensureOutboxSchema(db);
  const existing = db.prepare("SELECT * FROM outbox_batches WHERE state = 'pending' ORDER BY created_at, idempotency_key LIMIT 1").get();
  if (existing) {
    return {
      idempotencyKey: existing.idempotency_key,
      payload: JSON.parse(existing.payload_json),
      outboxIds: JSON.parse(existing.outbox_ids_json),
      createdAt: existing.created_at,
      reused: true,
    };
  }

  const rows = db.prepare('SELECT id, entity_type, entity_id, operation, payload_json, created_at FROM outbox ORDER BY created_at, id LIMIT ?')
    .all(Math.max(1, Math.min(500, Number(limit) || 100)));
  if (rows.length === 0) return null;

  const payload = { changes: buildChanges(rows) };
  const idempotencyKey = randomUUID();
  // Persist row snapshots so acknowledging an old request never deletes a newer edit.
  const snapshots = rows.map((row) => ({
    id: row.id, entity_type: row.entity_type, entity_id: row.entity_id,
    operation: row.operation, payload_json: row.payload_json,
  }));
  db.prepare(`
    INSERT INTO outbox_batches(idempotency_key, payload_json, outbox_ids_json, created_at, state)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(idempotencyKey, JSON.stringify(payload), JSON.stringify(snapshots), now);

  return { idempotencyKey, payload, outboxIds: snapshots, createdAt: now, reused: false };
}

function findResult(results, entityId) {
  if (!Array.isArray(results)) return null;
  return results.find((item) =>
    item && [item.entity_id, item.entityId, item.id, item.sale_id, item.saleId].includes(entityId),
  ) ?? null;
}

function isConfirmed(result) {
  return Boolean(result && ['applied', 'idempotent'].includes(result.status));
}

function applyPushResponse(db, batch, response, now = Date.now()) {
  ensureOutboxSchema(db);
  if (!batch || typeof batch.idempotencyKey !== 'string' || !Array.isArray(batch.outboxIds)) {
    throw new Error('Invalid push batch reference');
  }
  if (!response || typeof response !== 'object') throw new Error('Invalid push response');

  const batchRow = db.prepare('SELECT state FROM outbox_batches WHERE idempotency_key = ?').get(batch.idempotencyKey);
  if (!batchRow) throw new Error('Push batch is not persisted locally');
  if (batchRow.state === 'completed') return { acknowledged: 0, retained: 0, replay: true };

  const getOutbox = db.prepare('SELECT id, entity_type, entity_id FROM outbox WHERE id = ?');
  const remove = db.prepare('DELETE FROM outbox WHERE id = ?');
  const fail = db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?');
  let acknowledged = 0;
  let retained = 0;

  const tx = db.transaction(() => {
    for (const snapshot of batch.outboxIds) {
      const id = typeof snapshot === 'number' ? snapshot : snapshot.id;
      const row = getOutbox.get(id);
      if (!row) continue;
      const current = db.prepare('SELECT entity_type, entity_id, operation, payload_json FROM outbox WHERE id = ?').get(id);
      const sameSnapshot = !snapshot.payload_json || (
        current.entity_type === snapshot.entity_type && current.entity_id === snapshot.entity_id &&
        current.operation === snapshot.operation && current.payload_json === snapshot.payload_json
      );
      let result = null;
      if (row.entity_type === 'products') result = findResult(response.products, row.entity_id);
      else if (row.entity_type === 'staff') result = findResult(response.staff, row.entity_id);
      else if (row.entity_type === 'cash_sessions') result = findResult(response.cash_sessions, row.entity_id);
      else if (row.entity_type === 'sales') result = findResult(response.results, row.entity_id);

      if (isConfirmed(result) && sameSnapshot) {
        remove.run(id);
        acknowledged++;
      } else if (!sameSnapshot) {
        // The response concerns an older payload. Keep the newer edit queued.
        db.prepare('UPDATE outbox SET attempts = 0, last_error = NULL WHERE id = ?').run(id);
        retained++;
      } else {
        const detail = result?.errors?.join('; ') || result?.status || 'No per-entity success confirmation; retained for retry/review.';
        fail.run(String(detail).slice(0, 2000), id);
        retained++;
      }
    }
    db.prepare(`
      UPDATE outbox_batches
      SET state = 'completed', response_json = ?, completed_at = ?
      WHERE idempotency_key = ?
    `).run(JSON.stringify(response), now, batch.idempotencyKey);
  });
  tx();
  return { acknowledged, retained, replay: false };
}

function getOutboxStatus(db) {
  ensureOutboxSchema(db);
  const pending = db.prepare('SELECT count(*) AS n FROM outbox').get().n;
  const failed = db.prepare('SELECT count(*) AS n FROM outbox WHERE attempts > 0').get().n;
  return { pending: Number(pending), failed: Number(failed) };
}

module.exports = {
  ensureOutboxSchema, enqueueOutbox, preparePushBatch, applyPushResponse, getOutboxStatus,
};
