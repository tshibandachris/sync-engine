const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../electron/db/client.cjs');
const {
  enqueueOutbox, preparePushBatch, applyPushResponse, getOutboxStatus,
} = require('../electron/sync/outbox.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-outbox-'));
  const app = { getPath: () => root };
  let db = openDatabase(app);
  return {
    get db() { return db; },
    reopen() { db.close(); db = openDatabase(app); return db; },
    cleanup() { if (db?.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function product(id, name = 'Cahier') {
  return { id, name, price: 500, sku: null, barcode: null, category: null, lastKnownSyncSeq: 0 };
}

test('persists a queued operation and reuses the exact idempotent batch after restart', () => {
  const f = fixture();
  try {
    enqueueOutbox(f.db, { entityType: 'products', entityId: 'p-1', operation: 'create', payload: product('p-1'), now: 10 });
    const first = preparePushBatch(f.db, { now: 11 });
    assert.equal(first.payload.changes.products.length, 1);
    assert.equal(first.payload.changes.products[0].id, 'p-1');

    f.reopen();
    const retry = preparePushBatch(f.db, { now: 12 });
    assert.equal(retry.idempotencyKey, first.idempotencyKey);
    assert.deepEqual(retry.payload, first.payload);
    assert.equal(retry.reused, true);
  } finally {
    f.cleanup();
  }
});

test('acknowledges only confirmed entities and retains conflicts for review', () => {
  const f = fixture();
  try {
    enqueueOutbox(f.db, { entityType: 'products', entityId: 'p-ok', operation: 'create', payload: product('p-ok'), now: 10 });
    enqueueOutbox(f.db, { entityType: 'products', entityId: 'p-conflict', operation: 'update', payload: product('p-conflict', 'Classeur'), now: 11 });
    const batch = preparePushBatch(f.db, { now: 12 });
    const result = applyPushResponse(f.db, batch, {
      applied: { created: 1, updated: 0, deleted: 0 },
      conflicts: [],
      products: [
        { entity_id: 'p-ok', status: 'applied', sync_seq: 1 },
        { entity_id: 'p-conflict', status: 'conflict', errors: ['version mismatch'] },
      ],
    }, 13);

    assert.deepEqual(result, { acknowledged: 1, retained: 1, replay: false });
    assert.equal(getOutboxStatus(f.db).pending, 1);
    const row = f.db.prepare('SELECT entity_id, attempts, last_error FROM outbox').get();
    assert.equal(row.entity_id, 'p-conflict');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /version mismatch/);
  } finally {
    f.cleanup();
  }
});

test('rejects unsupported deletes and sales without their nested accounting records', () => {
  const f = fixture();
  try {
    assert.throws(() => enqueueOutbox(f.db, {
      entityType: 'cash_sessions', entityId: 'cs-1', operation: 'delete', payload: { id: 'cs-1' },
    }), /dedicated business workflow/);
    enqueueOutbox(f.db, {
      entityType: 'sales', entityId: 'sale-1', operation: 'create', payload: { id: 'sale-1', total: 100 },
    });
    assert.throws(() => preparePushBatch(f.db), /lines and stock_movements/);
    assert.equal(getOutboxStatus(f.db).pending, 1);
  } finally {
    f.cleanup();
  }
});

test('a completed batch cannot acknowledge rows a second time', () => {
  const f = fixture();
  try {
    enqueueOutbox(f.db, { entityType: 'products', entityId: 'p-1', operation: 'create', payload: product('p-1') });
    const batch = preparePushBatch(f.db);
    const response = {
      applied: { created: 1, updated: 0, deleted: 0 }, conflicts: [],
      products: [{ entity_id: 'p-1', status: 'idempotent' }],
    };
    assert.equal(applyPushResponse(f.db, batch, response).acknowledged, 1);
    assert.deepEqual(applyPushResponse(f.db, batch, response), { acknowledged: 0, retained: 0, replay: true });
    assert.equal(getOutboxStatus(f.db).pending, 0);
  } finally {
    f.cleanup();
  }
});

test('does not drop a newer edit queued while an older batch is in flight', () => {
  const f = fixture();
  try {
    enqueueOutbox(f.db, { entityType: 'products', entityId: 'p-1', operation: 'update', payload: product('p-1', 'Version A'), now: 10 });
    const batch = preparePushBatch(f.db, { now: 11 });
    enqueueOutbox(f.db, { entityType: 'products', entityId: 'p-1', operation: 'update', payload: product('p-1', 'Version B'), now: 12 });
    const result = applyPushResponse(f.db, batch, {
      applied: { created: 0, updated: 1, deleted: 0 }, conflicts: [],
      products: [{ entity_id: 'p-1', status: 'applied', sync_seq: 7 }],
    }, 13);
    assert.deepEqual(result, { acknowledged: 0, retained: 1, replay: false });
    const row = f.db.prepare('SELECT payload_json, attempts, last_error FROM outbox').get();
    assert.equal(JSON.parse(row.payload_json).name, 'Version B');
    assert.equal(row.attempts, 0);
    assert.equal(row.last_error, null);
  } finally {
    f.cleanup();
  }
});
