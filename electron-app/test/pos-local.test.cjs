const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openDatabase } = require('../electron/db/client.cjs');
const {
  listLocalStaff,
  listOpenCashSessions,
  openCashSession,
  requestCashSessionClose,
  createLocalSale,
} = require('../electron/db/pos.cjs');
const { getOutboxStatus, preparePushBatch } = require('../electron/sync/outbox.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-pos-local-'));
  const db = openDatabase({ getPath: () => root });
  const staffId = randomUUID();
  const productId = randomUUID();
  db.prepare(`
    INSERT INTO staff (id, display_name, role, is_active, created_at, updated_at)
    VALUES (?, 'Caissier test', 'cashier', 1, 100, 100)
  `).run(staffId);
  db.prepare(`
    INSERT INTO products (id, name, sku, price, cost, is_active, created_at, updated_at)
    VALUES (?, 'Cahier', 'CAH-01', 500, 250, 1, 100, 100)
  `).run(productId);
  db.prepare(`
    INSERT INTO stock_movements (
      id, product_id, movement_type, quantity_delta, reference_id, reference_type,
      unit_cost, notes, created_at, updated_at, created_by
    ) VALUES (?, ?, 'opening', 10, NULL, NULL, 250, NULL, 100, 100, ?)
  `).run(randomUUID(), productId, staffId);
  return {
    db, root, staffId, productId,
    cleanup() { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('opens a local cash session and queues its open-only sync payload', () => {
  const f = fixture();
  try {
    assert.equal(listLocalStaff(f.db).length, 1);
    const session = openCashSession(f.db, { staffId: f.staffId, openingAmount: 10000 }, 1000);
    assert.equal(session.staffId, f.staffId);
    assert.equal(session.status, 'open');
    assert.equal(listOpenCashSessions(f.db)[0].status, 'open');
    assert.equal(session.openingAmount, 10000);
    assert.equal(session.expectedCash, 10000);
    const batch = preparePushBatch(f.db);
    assert.equal(batch.payload.changes.cash_sessions[0].status, 'open');
    assert.equal(batch.payload.changes.cash_sessions[0].lastKnownSyncSeq, 0);
    assert.equal(getOutboxStatus(f.db).pending, 1);
  } finally {
    f.cleanup();
  }
});

test('rejects a second open session for the same cashier', () => {
  const f = fixture();
  try {
    openCashSession(f.db, { staffId: f.staffId, openingAmount: 0 }, 1000);
    assert.throws(
      () => openCashSession(f.db, { staffId: f.staffId, openingAmount: 0 }, 1001),
      /déjà une session/,
    );
    assert.equal(getOutboxStatus(f.db).pending, 1);
  } finally {
    f.cleanup();
  }
});

test('records a sale, sale lines, stock movements and outbox snapshot atomically', () => {
  const f = fixture();
  try {
    const session = openCashSession(f.db, { staffId: f.staffId, openingAmount: 1000 }, 1000);
    const sale = createLocalSale(f.db, {
      cashSessionId: session.id,
      lines: [{ productId: f.productId, quantity: 2 }],
      paymentMethod: 'mixed',
      cashAmount: 600,
      mobileAmount: 400,
    }, 2000);

    assert.equal(sale.total, 1000);
    assert.equal(sale.paymentMethod, 'mixed');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n, 1);
    assert.equal(f.db.prepare('SELECT SUM(quantity_delta) AS n FROM stock_movements WHERE product_id = ?').get(f.productId).n, 8);
    assert.equal(listOpenCashSessions(f.db)[0].expectedCash, 1600);

    const batch = preparePushBatch(f.db);
    assert.equal(batch.payload.changes.cash_sessions.length, 1);
    assert.equal(batch.payload.changes.sales.length, 1);
    assert.equal(batch.payload.changes.sales[0].lines[0].quantity, 2);
    assert.equal(batch.payload.changes.sales[0].stock_movements[0].quantity_delta, -2);
    assert.equal(getOutboxStatus(f.db).pending, 2);
  } finally {
    f.cleanup();
  }
});

test('rejects payment splits that do not reconcile to the sale total', () => {
  const f = fixture();
  try {
    const session = openCashSession(f.db, { staffId: f.staffId, openingAmount: 0 }, 1000);
    assert.throws(() => createLocalSale(f.db, {
      cashSessionId: session.id,
      lines: [{ productId: f.productId, quantity: 2 }],
      paymentMethod: 'mixed',
      cashAmount: 1000,
      mobileAmount: 1,
    }, 2000), /doit égaler le total/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n, 0);
    assert.equal(getOutboxStatus(f.db).pending, 1);
  } finally {
    f.cleanup();
  }
});

test('rejects overselling tracked stock without writing partial ledger records', () => {
  const f = fixture();
  try {
    const session = openCashSession(f.db, { staffId: f.staffId, openingAmount: 0 }, 1000);
    assert.throws(() => createLocalSale(f.db, {
      cashSessionId: session.id,
      lines: [{ productId: f.productId, quantity: 11 }],
      paymentMethod: 'cash',
      cashAmount: 5500,
      mobileAmount: 0,
    }, 2000), /Stock insuffisant/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n, 0);
    assert.equal(getOutboxStatus(f.db).pending, 1);
  } finally {
    f.cleanup();
  }
});

test('serializes competing sale writers and reports SQLITE_BUSY without queueing a sale', () => {
  const f = fixture();
  const competingDb = openDatabase({ getPath: () => f.root });
  try {
    const session = openCashSession(f.db, { staffId: f.staffId, openingAmount: 0 }, 1000);
    f.db.prepare(`
      UPDATE stock_movements SET quantity_delta = 1
      WHERE product_id = ? AND movement_type = 'opening'
    `).run(f.productId);

    assert.equal(f.db.pragma('busy_timeout', { simple: true }), 5000);
    f.db.pragma('busy_timeout = 25');
    competingDb.pragma('busy_timeout = 25');

    // Hold a write reservation from the second connection. The sale writer
    // must wait for busy_timeout, then reject without creating any local work.
    competingDb.exec('BEGIN IMMEDIATE');
    assert.throws(() => createLocalSale(f.db, {
      cashSessionId: session.id,
      lines: [{ productId: f.productId, quantity: 1 }],
      paymentMethod: 'cash',
      cashAmount: 500,
      mobileAmount: 0,
    }, 2000), (error) => {
      assert.equal(error.code, 'POS_DATABASE_BUSY');
      assert.match(error.message, /Aucune vente n’a été enregistrée/);
      assert.equal(error.cause?.code, 'SQLITE_BUSY');
      return true;
    });

    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n, 0);
    assert.equal(f.db.prepare('SELECT SUM(quantity_delta) AS n FROM stock_movements WHERE product_id = ?').get(f.productId).n, 1);
    assert.equal(getOutboxStatus(f.db).pending, 1);

    competingDb.exec('ROLLBACK');
    const sale = createLocalSale(f.db, {
      cashSessionId: session.id,
      lines: [{ productId: f.productId, quantity: 1 }],
      paymentMethod: 'cash',
      cashAmount: 500,
      mobileAmount: 0,
    }, 2001);

    assert.ok(sale.id);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n, 1);
    assert.equal(f.db.prepare('SELECT SUM(quantity_delta) AS n FROM stock_movements WHERE product_id = ?').get(f.productId).n, 0);
    assert.equal(getOutboxStatus(f.db).pending, 2);
  } finally {
    try { if (competingDb.inTransaction) competingDb.exec('ROLLBACK'); } catch {}
    if (competingDb.open) competingDb.close();
    f.cleanup();
  }
});

test('a local close request blocks further sales until server confirmation', () => {
  const f = fixture();
  try {
    const session = openCashSession(f.db, { staffId: f.staffId, openingAmount: 1000 }, 1000);
    const request = requestCashSessionClose(f.db, {
      cashSessionId: session.id, closingAmount: 1000, notes: 'Fin de journée',
    }, 2000);
    assert.equal(request.syncState, 'pending');
    const local = f.db.prepare(
      'SELECT status, closed_at, close_sync_state FROM cash_sessions WHERE id = ?',
    ).get(session.id);
    assert.equal(local.status, 'open');
    assert.equal(local.closed_at, null);
    assert.equal(local.close_sync_state, 'pending');
    assert.equal(listOpenCashSessions(f.db)[0].closeRequested, true);
    assert.throws(() => createLocalSale(f.db, {
      cashSessionId: session.id,
      lines: [{ productId: f.productId, quantity: 1 }],
      paymentMethod: 'cash', cashAmount: 500, mobileAmount: 0,
    }, 3000), /Aucune session/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
  } finally {
    f.cleanup();
  }
});
