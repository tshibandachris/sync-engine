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

test('builds a product push payload that strictly matches the server contract', () => {
  const f = fixture();
  try {
    const id = '00000000-0000-4000-8000-000000000101';
    enqueueOutbox(f.db, {
      entityType: 'products',
      entityId: id,
      operation: 'create',
      payload: {
        id,
        name: 'Cahier',
        sku: 'CAH-01',
        barcode: '1234567890123',
        category: 'Papeterie',
        price: 500,
        cost: 250,
        stockAlert: 5,
        isActive: true,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        deletedAt: null,
        lastKnownSyncSeq: 0,
        serverOwnedField: 'must not leak',
      },
      now: 1700000001000,
    });

    const batch = preparePushBatch(f.db);
    const productPayload = batch.payload.changes.products[0];
    const allowedKeys = [
      'id', 'name', 'sku', 'barcode', 'category', 'price', 'cost',
      'stockAlert', 'isActive', 'createdAt', 'deletedAt', 'lastKnownSyncSeq',
    ];

    assert.deepEqual(Object.keys(productPayload).sort(), allowedKeys.sort());
    assert.equal(Object.hasOwn(productPayload, 'updatedAt'), false);
    assert.equal(Object.hasOwn(productPayload, 'serverOwnedField'), false);
    assert.equal(productPayload.lastKnownSyncSeq, 0);
    assert.equal(productPayload.createdAt, 1700000000000);
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
    const incompleteSale = validSalePayload();
    delete incompleteSale.lines;
    delete incompleteSale.stock_movements;
    enqueueOutbox(f.db, {
      entityType: 'sales', entityId: incompleteSale.id, operation: 'create', payload: incompleteSale,
    });
    assert.throws(() => preparePushBatch(f.db), /lines must contain at least one line/);
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


function validSalePayload() {
  const saleId = '00000000-0000-4000-8000-000000000001';
  const staffId = '00000000-0000-4000-8000-000000000002';
  const productId = '00000000-0000-4000-8000-000000000003';
  const now = 1700000000000;
  return {
    id: saleId,
    cash_session_id: '00000000-0000-4000-8000-000000000004',
    staff_id: staffId,
    sale_number: 'S-000001',
    total: 1000,
    payment_method: 'cash',
    cash_amount: 1000,
    mobile_amount: 0,
    is_void: false,
    voided_sale_id: null,
    void_reason: null,
    created_at: now,
    updated_at: now,
    lines: [{
      id: '00000000-0000-4000-8000-000000000005',
      product_id: productId,
      product_name: 'Cahier',
      product_sku: null,
      quantity: 2,
      unit_price: 500,
      subtotal: 1000,
      created_at: now,
      updated_at: now,
    }],
    stock_movements: [{
      id: '00000000-0000-4000-8000-000000000006',
      product_id: productId,
      movement_type: 'sale',
      quantity_delta: -2,
      reference_id: saleId,
      reference_type: 'sale',
      unit_cost: null,
      notes: null,
      created_at: now,
      updated_at: now,
      created_by: staffId,
    }],
  };
}

test('accepts a sale matching the server contract before preparing a push batch', () => {
  const f = fixture();
  try {
    const payload = validSalePayload();
    enqueueOutbox(f.db, { entityType: 'sales', entityId: payload.id, operation: 'create', payload });
    const batch = preparePushBatch(f.db);
    assert.equal(batch.payload.changes.sales.length, 1);
    assert.equal(batch.payload.changes.sales[0].sale_number, 'S-000001');
    assert.equal(batch.payload.changes.sales[0].lines[0].product_name, 'Cahier');
    assert.equal(batch.payload.changes.sales[0].stock_movements[0].reference_id, payload.id);
  } finally {
    f.cleanup();
  }
});

test('rejects sales missing required header, line label, or stock movement references', () => {
  const invalidCases = [
    { label: 'sale_number', mutate: (sale) => { delete sale.sale_number; }, expected: /sale_number is required/ },
    { label: 'product_name', mutate: (sale) => { delete sale.lines[0].product_name; }, expected: /product_name is required/ },
    { label: 'reference_id', mutate: (sale) => { delete sale.stock_movements[0].reference_id; }, expected: /reference_id must be a UUID/ },
    { label: 'reference_type', mutate: (sale) => { sale.stock_movements[0].reference_type = 'other'; }, expected: /must reference this sale/ },
  ];
  for (const item of invalidCases) {
    const f = fixture();
    try {
      const payload = validSalePayload();
      item.mutate(payload);
      enqueueOutbox(f.db, { entityType: 'sales', entityId: payload.id, operation: 'create', payload });
      assert.throws(() => preparePushBatch(f.db), item.expected, item.label);
      assert.equal(getOutboxStatus(f.db).pending, 1, 'invalid sales remain safely queued');
    } finally {
      f.cleanup();
    }
  }
});
