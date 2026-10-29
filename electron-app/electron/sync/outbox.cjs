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


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`Sale contract: ${field} must be a UUID.`);
  }
}

function requireSafeInteger(value, field, { min = Number.MIN_SAFE_INTEGER, nonZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < min || (nonZero && value === 0)) {
    throw new Error(`Sale contract: ${field} must be a safe integer${nonZero ? ' other than zero' : ''}.`);
  }
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Sale contract: unknown field ${field}.${key}.`);
  }
}

function validateSalePayload(sale) {
  assertAllowedKeys(sale, new Set([
    'id', 'cash_session_id', 'staff_id', 'sale_number', 'total', 'payment_method',
    'cash_amount', 'mobile_amount', 'mobile_msisdn', 'mobile_reference', 'customer_note',
    'is_void', 'voided_sale_id', 'void_reason', 'created_at', 'updated_at', 'lines', 'stock_movements',
  ]), 'sale');
  for (const [field, max] of [['mobile_msisdn', 20], ['mobile_reference', 64], ['customer_note', 200]]) {
    if (sale[field] != null && (typeof sale[field] !== 'string' || sale[field].length > max)) {
      throw new Error(`Sale contract: ${field} must be at most ${max} characters or null.`);
    }
  }
  for (const field of ['id', 'cash_session_id', 'staff_id']) requireUuid(sale[field], field);
  if (typeof sale.sale_number !== 'string' || sale.sale_number.trim().length < 1 || sale.sale_number.length > 32) {
    throw new Error('Sale contract: sale_number is required (1–32 characters).');
  }
  if (!['cash', 'mobile_money', 'mixed'].includes(sale.payment_method)) {
    throw new Error('Sale contract: payment_method must be cash, mobile_money, or mixed.');
  }
  for (const field of ['total', 'cash_amount', 'mobile_amount']) requireSafeInteger(sale[field], field);
  for (const field of ['created_at', 'updated_at']) requireSafeInteger(sale[field], field, { min: 0 });
  if (sale.total !== sale.cash_amount + sale.mobile_amount) {
    throw new Error('Sale contract: total must equal cash_amount + mobile_amount.');
  }

  const isVoid = sale.is_void ?? false;
  if (typeof isVoid !== 'boolean') throw new Error('Sale contract: is_void must be boolean.');
  if (isVoid) {
    requireUuid(sale.voided_sale_id, 'voided_sale_id');
    if (typeof sale.void_reason !== 'string' || !sale.void_reason.trim() || sale.void_reason.length > 200 ||
        sale.total > 0 || sale.cash_amount > 0 || sale.mobile_amount > 0) {
      throw new Error('Sale contract: a void requires voided_sale_id, void_reason, and non-positive amounts.');
    }
  } else if (sale.voided_sale_id != null || sale.void_reason != null) {
    throw new Error('Sale contract: a normal sale cannot reference a void.');
  }
  if (!Array.isArray(sale.lines) || sale.lines.length < 1) {
    throw new Error('Sale contract: lines must contain at least one line.');
  }
  let lineTotal = 0;
  for (let i = 0; i < sale.lines.length; i++) {
    const line = sale.lines[i];
    const prefix = `lines[${i}]`;
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      throw new Error(`Sale contract: ${prefix} must be an object.`);
    }
    assertAllowedKeys(line, new Set(['id', 'product_id', 'product_name', 'product_sku', 'quantity', 'unit_price', 'subtotal', 'created_at', 'updated_at']), prefix);
    requireUuid(line.id, `${prefix}.id`);
    requireUuid(line.product_id, `${prefix}.product_id`);
    if (typeof line.product_name !== 'string' || !line.product_name.trim() || line.product_name.length > 200) {
      throw new Error(`Sale contract: ${prefix}.product_name is required (1–200 characters).`);
    }
    if (line.product_sku != null && (typeof line.product_sku !== 'string' || line.product_sku.length > 64)) {
      throw new Error(`Sale contract: ${prefix}.product_sku must be at most 64 characters or null.`);
    }
    requireSafeInteger(line.quantity, `${prefix}.quantity`, { nonZero: true });
    requireSafeInteger(line.unit_price, `${prefix}.unit_price`, { min: 0 });
    requireSafeInteger(line.subtotal, `${prefix}.subtotal`);
    for (const field of ['created_at', 'updated_at']) requireSafeInteger(line[field], `${prefix}.${field}`, { min: 0 });
    if (line.subtotal !== line.quantity * line.unit_price) {
      throw new Error(`Sale contract: ${prefix}.subtotal must equal quantity × unit_price.`);
    }
    lineTotal += line.subtotal;
  }
  if (!Number.isSafeInteger(lineTotal) || lineTotal !== sale.total) {
    throw new Error('Sale contract: line subtotals must sum to total.');
  }

  if (!Array.isArray(sale.stock_movements)) {
    throw new Error('Sale contract: stock_movements must be an array.');
  }
  for (let i = 0; i < sale.stock_movements.length; i++) {
    const movement = sale.stock_movements[i];
    const prefix = `stock_movements[${i}]`;
    if (!movement || typeof movement !== 'object' || Array.isArray(movement)) {
      throw new Error(`Sale contract: ${prefix} must be an object.`);
    }
    assertAllowedKeys(movement, new Set(['id', 'product_id', 'movement_type', 'quantity_delta', 'reference_id', 'reference_type', 'unit_cost', 'notes', 'created_at', 'updated_at', 'created_by']), prefix);
    requireUuid(movement.id, `${prefix}.id`);
    requireUuid(movement.product_id, `${prefix}.product_id`);
    if (!['sale', 'void'].includes(movement.movement_type)) {
      throw new Error(`Sale contract: ${prefix}.movement_type must be sale or void.`);
    }
    requireSafeInteger(movement.quantity_delta, `${prefix}.quantity_delta`, { nonZero: true });
    requireUuid(movement.reference_id, `${prefix}.reference_id`);
    if (movement.reference_id !== sale.id || movement.reference_type !== 'sale') {
      throw new Error(`Sale contract: ${prefix} must reference this sale with reference_type="sale".`);
    }
    if (movement.unit_cost != null) requireSafeInteger(movement.unit_cost, `${prefix}.unit_cost`, { min: 0 });
    if (movement.notes != null && (typeof movement.notes !== 'string' || movement.notes.length > 500)) {
      throw new Error(`Sale contract: ${prefix}.notes must be at most 500 characters or null.`);
    }
    for (const field of ['created_at', 'updated_at']) requireSafeInteger(movement[field], `${prefix}.${field}`, { min: 0 });
    if (movement.created_by != null) requireUuid(movement.created_by, `${prefix}.created_by`);
  }
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
        ...((payload.updatedAt ?? payload.updated_at) === undefined ? {} : { updatedAt: payload.updatedAt ?? payload.updated_at }),
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
      validateSalePayload(payload);
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
