const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openDatabase, applyPulledPage, getCursor } = require('../electron/db/client.cjs');
const { pullChanges, pushChanges } = require('../electron/sync/api-client.cjs');
const { enqueueOutbox, preparePushBatch, getOutboxStatus } = require('../electron/sync/outbox.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-field-simulation-'));
  const app = { getPath: () => root };
  let db = openDatabase(app);
  return {
    root,
    app,
    get db() { return db; },
    close() { if (db?.open) db.close(); },
    reopen() { if (db?.open) db.close(); db = openDatabase(app); return db; },
    cleanup() {
      if (db?.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function emptyChanges(overrides = {}) {
  const buckets = [
    'check_ins', 'missions', 'sites', 'products', 'staff',
    'cash_sessions', 'sales', 'sale_lines', 'stock_movements',
  ];
  return Object.fromEntries(buckets.map((name) => [
    name,
    { created: [], updated: [], deleted: [], ...(overrides[name] || {}) },
  ]));
}

function fieldPullPage(timestamp = 40) {
  const now = 1700000000000;
  const saleId = 'field-sale-001';
  const productId = 'field-product-001';
  return {
    timestamp,
    has_more: false,
    changes: emptyChanges({
      sales: {
        created: [{
          id: saleId, cash_session_id: 'field-session-001', staff_id: 'field-staff-001',
          sale_number: 'FIELD-0001', total: 1500, payment_method: 'cash',
          cash_amount: 1500, mobile_amount: 0, created_at: now, updated_at: now,
          last_known_sync_seq: 21,
        }],
      },
      sale_lines: {
        created: [{
          id: 'field-line-001', sale_id: saleId, product_id: productId,
          product_name: 'Cahier de test', product_sku: 'CAH-FIELD',
          quantity: 3, unit_price: 500, subtotal: 1500,
          created_at: now, updated_at: now, last_known_sync_seq: 22,
        }],
      },
      stock_movements: {
        created: [{
          id: 'field-movement-001', product_id: productId, movement_type: 'sale',
          quantity_delta: -3, reference_id: saleId, reference_type: 'sale',
          unit_cost: 250, notes: 'field simulation', created_at: now, updated_at: now,
          created_by: 'field-staff-001', last_known_sync_seq: 23,
        }],
      },
    }),
  };
}

function counts(db) {
  return {
    sales: db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,
    saleLines: db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n,
    stockMovements: db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,
    cachedEntities: db.prepare('SELECT COUNT(*) AS n FROM synced_entities').get().n,
    cursor: getCursor(db),
  };
}

function fakeResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('Scénario 2 — coupure au milieu du cycle Pull/Push : page atomique, outbox conservée', async () => {
  const f = fixture();
  try {
    const page = fieldPullPage(40);
    let calls = 0;
    const fetchImpl = async (_url, options) => {
      calls++;
      if (calls === 1) {
        assert.equal(options.method, 'POST');
        return fakeResponse(page);
      }
      throw new TypeError('Simulated network cut between pull and push');
    };

    const pulled = await pullChanges({
      baseUrl: 'http://127.0.0.1:3000', token: 'field-test-token',
      lastPulledAt: 0, fetchImpl,
    });
    applyPulledPage(f.db, pulled);

    enqueueOutbox(f.db, {
      entityType: 'products',
      entityId: 'local-product-pending',
      operation: 'create',
      payload: { id: 'local-product-pending', name: 'Produit local', price: 100 },
      now: 50,
    });
    const batch = preparePushBatch(f.db, { now: 51 });

    await assert.rejects(
      pushChanges({
        baseUrl: 'http://127.0.0.1:3000', token: 'field-test-token',
        idempotencyKey: batch.idempotencyKey, payload: batch.payload, fetchImpl,
      }),
      /Simulated network cut/,
    );

    assert.deepEqual(counts(f.db), {
      sales: 1, saleLines: 1, stockMovements: 1, cachedEntities: 3, cursor: 40,
    }, 'a completed pull page must be wholly present, never partially persisted');
    assert.equal(getOutboxStatus(f.db).pending, 1, 'failed push must not acknowledge local work');

    const before = counts(f.db);
    await assert.rejects(
      pullChanges({
        baseUrl: 'http://127.0.0.1:3000', token: 'field-test-token',
        lastPulledAt: 40, fetchImpl: async () => { throw new TypeError('Simulated pull disconnect'); },
      }),
      /Simulated pull disconnect/,
    );
    assert.deepEqual(counts(f.db), before);
    assert.equal(calls, 2);
  } finally {
    f.cleanup();
  }
});

test('Scénario 2 — erreur injectée après ventes/lignes : ROLLBACK intégral du pull', () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER fail_field_stock_movement BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT, 'injected stock write failure'); END;");

    assert.throws(
      () => applyPulledPage(f.db, fieldPullPage(41)),
      /injected stock write failure/,
    );
    assert.deepEqual(counts(f.db), {
      sales: 0, saleLines: 0, stockMovements: 0, cachedEntities: 0, cursor: 0,
    }, 'sale, sale lines, cache rows and cursor must roll back as one transaction');

    f.reopen();
    assert.deepEqual(counts(f.db), {
      sales: 0, saleLines: 0, stockMovements: 0, cachedEntities: 0, cursor: 0,
    }, 'rollback must remain true after closing and reopening the on-disk database');
  } finally {
    f.cleanup();
  }
});

test('Scénario 3 — arrêt brutal du processus dans une transaction : SQLite récupère sans écritures partielles', () => {
  const f = fixture();
  try {
    const clientPath = path.resolve(__dirname, '../electron/db/client.cjs');
    f.close();

    const childSource = [
      "const { openDatabase } = require(process.argv[1]);",
      "const root = process.argv[2];",
      "const db = openDatabase({ getPath: () => root });",
      "db.exec('BEGIN IMMEDIATE');",
      "db.prepare(\"INSERT INTO sales (id, cash_session_id, staff_id, sale_number, total, payment_method, created_at, updated_at, last_known_sync_seq) VALUES ('crash-sale', 'crash-session', 'crash-staff', 'CRASH-1', 900, 'cash', 100, 100, 1)\").run();",
      "db.prepare(\"INSERT INTO sale_lines (id, sale_id, product_id, product_name, quantity, unit_price, subtotal, created_at, updated_at, last_known_sync_seq) VALUES ('crash-line', 'crash-sale', 'crash-product', 'Partial item', 1, 900, 900, 100, 100, 1)\").run();",
      "require('node:fs').writeSync(1, 'writes staged; exiting before stock movement and COMMIT');",
      "process.exit(73);",
    ].join('\n');

    const child = spawnSync(process.execPath, ['-e', childSource, clientPath, f.root], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 73, `child exit status; stderr=${child.stderr}`);
    assert.match(child.stdout, /writes staged/);

    f.reopen();
    assert.deepEqual(counts(f.db), {
      sales: 0, saleLines: 0, stockMovements: 0, cachedEntities: 0, cursor: 0,
    }, 'SQLite recovery must discard every uncommitted write after abrupt process exit');
  } finally {
    f.cleanup();
  }
});
