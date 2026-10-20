const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function openDatabase(app) {
  const dataDir = path.join(app.getPath('appData'), 'EdenGestion');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'data.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT,
      barcode TEXT,
      category TEXT,
      price INTEGER NOT NULL DEFAULT 0,
      cost INTEGER,
      stock_alert INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER,
      deleted_at INTEGER,
      last_known_sync_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      pin_hash TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_known_sync_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      terminal_label TEXT,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      opening_amount INTEGER NOT NULL DEFAULT 0,
      closing_amount INTEGER,
      expected_amount INTEGER,
      difference INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      reconciled_expected_amount INTEGER,
      reconciled_difference INTEGER,
      reconciled_at INTEGER,
      reconciliation_alert INTEGER,
      reconciliation_alert_reason TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_known_sync_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      cash_session_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      sale_number TEXT NOT NULL,
      total INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      cash_amount INTEGER NOT NULL DEFAULT 0,
      mobile_amount INTEGER NOT NULL DEFAULT 0,
      mobile_msisdn TEXT,
      mobile_reference TEXT,
      customer_note TEXT,
      is_void INTEGER NOT NULL DEFAULT 0,
      voided_sale_id TEXT,
      void_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_known_sync_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sale_lines (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_sku TEXT,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_known_sync_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      quantity_delta INTEGER NOT NULL,
      reference_id TEXT,
      reference_type TEXT,
      unit_cost INTEGER,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT,
      last_known_sync_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      UNIQUE(entity_type, entity_id, operation)
    );

    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_sales_session ON sales(cash_session_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at, id);
  `);

  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    .run(1, Date.now());

  return db;
}

function applyPulledProducts(db, productChanges) {
  const upsert = db.prepare(`
    INSERT INTO products (
      id, name, sku, barcode, category, price, cost, stock_alert,
      is_active, created_at, updated_at, deleted_at, last_known_sync_seq
    ) VALUES (
      @id, @name, @sku, @barcode, @category, @price, @cost, @stockAlert,
      @isActive, @createdAt, @updatedAt, @deletedAt, @lastKnownSyncSeq
    )
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, sku=excluded.sku, barcode=excluded.barcode,
      category=excluded.category, price=excluded.price, cost=excluded.cost,
      stock_alert=excluded.stock_alert, is_active=excluded.is_active,
      created_at=excluded.created_at, updated_at=excluded.updated_at,
      deleted_at=excluded.deleted_at, last_known_sync_seq=excluded.last_known_sync_seq
    WHERE excluded.last_known_sync_seq >= products.last_known_sync_seq
  `);
  const apply = db.transaction((changes) => {
    let upserted = 0;
    for (const p of [...(changes.created || []), ...(changes.updated || [])]) {
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
      upsert.run({
        id: p.id, name: p.name, sku: p.sku ?? null, barcode: p.barcode ?? null,
        category: p.category ?? null, price: Number(p.price ?? 0), cost: p.cost ?? null,
        stockAlert: p.stockAlert ?? p.stock_alert ?? null,
        isActive: p.isActive === false || p.is_active === false ? 0 : 1,
        createdAt: p.createdAt ?? p.created_at ?? null,
        updatedAt: p.updatedAt ?? p.updated_at ?? null,
        deletedAt: p.deletedAt ?? p.deleted_at ?? null,
        lastKnownSyncSeq: Number(p.lastKnownSyncSeq ?? 0),
      });
      upserted++;
    }
    for (const p of changes.deleted || []) {
      if (p && typeof p.id === 'string') {
        db.prepare('UPDATE products SET deleted_at = ?, last_known_sync_seq = ? WHERE id = ?')
          .run(p.deletedAt ?? p.deleted_at ?? Date.now(), Number(p.lastKnownSyncSeq ?? 0), p.id);
      }
    }
    return upserted;
  });
  return apply(productChanges || {});
}

module.exports = { openDatabase, applyPulledProducts };
