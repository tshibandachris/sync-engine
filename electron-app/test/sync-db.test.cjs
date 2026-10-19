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
        created: [{ id: 'sale-1', total: 1250, lastKnownSyncSeq: 8 }],
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
      /Invalid sales record/,
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
