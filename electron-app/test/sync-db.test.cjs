const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, applyPulledPage, getCursor } = require('../electron/db/client.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-gestion-sync-'));
  const app = { getPath: () => root };
  const db = openDatabase(app);
  return {
    root,
    db,
    reopen() {
      db.close();
      return openDatabase(app);
    },
    cleanup(database) {
      if (database && database.open) database.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function emptyChanges(overrides = {}) {
  return {
    check_ins: { created: [], updated: [], deleted: [] },
    missions: { created: [], updated: [], deleted: [] },
    sites: { created: [], updated: [], deleted: [] },
    products: { created: [], updated: [], deleted: [] },
    staff: { created: [], updated: [], deleted: [] },
    cash_sessions: { created: [], updated: [], deleted: [] },
    sales: { created: [], updated: [], deleted: [] },
    sale_lines: { created: [], updated: [], deleted: [] },
    stock_movements: { created: [], updated: [], deleted: [] },
    ...overrides,
  };
}

test('persists the global pull cursor across database reopen', () => {
  const f = fixture();
  let db = f.db;
  try {
    applyPulledPage(db, { timestamp: 34, has_more: false, changes: emptyChanges() });
    assert.equal(getCursor(db), 34);
    db = f.reopen();
    assert.equal(getCursor(db), 34);
  } finally {
    f.cleanup(db);
  }
});

test('applies an entity and its cursor in the same transaction', () => {
  const f = fixture();
  try {
    const changes = emptyChanges({
      sales: {
        created: [{
          id: 'sale-1', total: 1250, sale_number: 'S-1',
          cash_session_id: 'session-1', staff_id: 'staff-1', payment_method: 'cash',
          created_at: 100, updated_at: 100, last_known_sync_seq: 8,
        }],
        updated: [],
        deleted: [],
      },
    });
    applyPulledPage(f.db, { timestamp: 8, has_more: false, changes });
    const row = f.db.prepare(
      "SELECT payload_json, last_known_sync_seq FROM synced_entities WHERE entity_type = 'sales' AND id = 'sale-1'",
    ).get();
    assert.equal(JSON.parse(row.payload_json).total, 1250);
    assert.equal(row.last_known_sync_seq, 8);
    assert.equal(getCursor(f.db), 8);
  } finally {
    f.cleanup(f.db);
  }
});

test('does not advance the cursor or retain partial records when a page is invalid', () => {
  const f = fixture();
  try {
    const changes = emptyChanges({
      sales: {
        created: [{ id: 'sale-should-rollback', total: 100, sync_seq: 9 }],
        updated: [{ name: 'missing-id' }],
        deleted: [],
      },
    });
    assert.throws(
      () => applyPulledPage(f.db, { timestamp: 9, has_more: false, changes }),
      /Invalid sales/,
    );
    assert.equal(getCursor(f.db), 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM synced_entities').get().n, 0);
  } finally {
    f.cleanup(f.db);
  }
});

test('uses snake_case sync sequence fields for product records', () => {
  const f = fixture();
  try {
    const changes = emptyChanges({
      products: {
        created: [{
          id: 'product-1', name: 'Cahier', price: 500,
          last_known_sync_seq: 12,
        }],
        updated: [],
        deleted: [],
      },
    });
    applyPulledPage(f.db, { timestamp: 12, has_more: false, changes });
    const product = f.db.prepare('SELECT name, last_known_sync_seq FROM products WHERE id = ?').get('product-1');
    assert.equal(product.name, 'Cahier');
    assert.equal(product.last_known_sync_seq, 12);
  } finally {
    f.cleanup(f.db);
  }
});

test('persists pulled sales, sale lines, and stock movements in the operational POS tables', () => {
  const f = fixture();
  try {
    const now = 1700000000000;
    const saleId = 'sale-pull-1';
    const productId = 'product-pull-1';
    const changes = emptyChanges({
      sales: {
        created: [{
          id: saleId, cash_session_id: 'session-pull-1', staff_id: 'staff-pull-1',
          sale_number: 'S-PULL-001', total: 1000, payment_method: 'cash',
          cash_amount: 1000, mobile_amount: 0, is_void: false,
          created_at: now, updated_at: now, lastKnownSyncSeq: 11,
        }], updated: [], deleted: [],
      },
      sale_lines: {
        created: [{
          id: 'line-pull-1', sale_id: saleId, product_id: productId,
          product_name: 'Cahier', product_sku: 'CAH-01',
          quantity: 2, unit_price: 500, subtotal: 1000,
          created_at: now, updated_at: now, lastKnownSyncSeq: 12,
        }], updated: [], deleted: [],
      },
      stock_movements: {
        created: [{
          id: 'movement-pull-1', product_id: productId, movement_type: 'sale',
          quantity_delta: -2, reference_id: saleId, reference_type: 'sale',
          unit_cost: 250, notes: null, created_at: now, updated_at: now,
          created_by: 'staff-pull-1', lastKnownSyncSeq: 13,
        }], updated: [], deleted: [],
      },
    });

    applyPulledPage(f.db, { timestamp: 13, has_more: false, changes });

    assert.deepEqual(f.db.prepare(
      'SELECT id, sale_number, total, payment_method, last_known_sync_seq FROM sales WHERE id = ?',
    ).get(saleId), {
      id: saleId, sale_number: 'S-PULL-001', total: 1000,
      payment_method: 'cash', last_known_sync_seq: 11,
    });
    assert.deepEqual(f.db.prepare(
      'SELECT id, sale_id, product_id, quantity, unit_price, subtotal, last_known_sync_seq FROM sale_lines WHERE id = ?',
    ).get('line-pull-1'), {
      id: 'line-pull-1', sale_id: saleId, product_id: productId,
      quantity: 2, unit_price: 500, subtotal: 1000, last_known_sync_seq: 12,
    });
    assert.deepEqual(f.db.prepare(
      'SELECT id, product_id, quantity_delta, reference_id, last_known_sync_seq FROM stock_movements WHERE id = ?',
    ).get('movement-pull-1'), {
      id: 'movement-pull-1', product_id: productId, quantity_delta: -2,
      reference_id: saleId, last_known_sync_seq: 13,
    });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n, 1);
    assert.equal(getCursor(f.db), 13);
  } finally {
    f.cleanup(f.db);
  }
});

test('rejects a backwards cursor without changing stored state', () => {
  const f = fixture();
  try {
    applyPulledPage(f.db, { timestamp: 20, has_more: false, changes: emptyChanges() });
    assert.throws(
      () => applyPulledPage(f.db, { timestamp: 19, has_more: false, changes: emptyChanges() }),
      /cursor moved backwards/,
    );
    assert.equal(getCursor(f.db), 20);
  } finally {
    f.cleanup(f.db);
  }
});


test('persists pulled staff and cash sessions into local queryable tables', () => {
  const f = fixture();
  try {
    const now = 1700000000000;
    const changes = emptyChanges({
      staff: {
        created: [{
          id: 'staff-seed-1',
          displayName: 'Cashier',
          role: 'cashier',
          isActive: true,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          lastKnownSyncSeq: 3,
        }],
        updated: [],
        deleted: [],
      },
      cash_sessions: {
        created: [{
          id: 'session-seed-1',
          staffId: 'staff-seed-1',
          terminalLabel: 'Front desk',
          openedAt: now,
          closedAt: null,
          openingAmount: 10000,
          closingAmount: null,
          expectedAmount: null,
          difference: null,
          status: 'open',
          notes: null,
          reconciledExpectedAmount: null,
          reconciledDifference: null,
          reconciledAt: null,
          reconciliationAlert: null,
          reconciliationAlertReason: null,
          createdAt: now,
          updatedAt: now,
          lastKnownSyncSeq: 4,
        }],
        updated: [],
        deleted: [],
      },
    });

    applyPulledPage(f.db, { timestamp: 4, has_more: false, changes });

    const staff = f.db.prepare(
      'SELECT display_name, role, is_active, pin_hash, last_known_sync_seq FROM staff WHERE id = ?',
    ).get('staff-seed-1');
    assert.equal(staff.display_name, 'Cashier');
    assert.equal(staff.role, 'cashier');
    assert.equal(staff.is_active, 1);
    assert.equal(staff.pin_hash, null, 'pull must never provision a staff PIN hash');
    assert.equal(staff.last_known_sync_seq, 3);

    const session = f.db.prepare(
      'SELECT staff_id, terminal_label, opened_at, opening_amount, status, last_known_sync_seq FROM cash_sessions WHERE id = ?',
    ).get('session-seed-1');
    assert.equal(session.staff_id, 'staff-seed-1');
    assert.equal(session.terminal_label, 'Front desk');
    assert.equal(session.opened_at, now);
    assert.equal(session.opening_amount, 10000);
    assert.equal(session.status, 'open');
    assert.equal(session.last_known_sync_seq, 4);
    assert.equal(f.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 2);
  } finally {
    f.cleanup(f.db);
  }
});
