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

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS synced_entities (
      entity_type TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      deleted_at INTEGER,
      last_known_sync_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (entity_type, id)
    );

    CREATE INDEX IF NOT EXISTS idx_synced_entities_type_seq
      ON synced_entities(entity_type, last_known_sync_seq);

    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_sales_session ON sales(cash_session_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at, id);
  `);

  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    .run(1, Date.now());

  // Forward-only migration: preserve existing local databases while tracking staff tombstones.
  const currentVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version);
  if (currentVersion < 2) {
    const migrate = db.transaction(() => {
      const staffColumns = db.pragma('table_info(staff)');
      if (!staffColumns.some((column) => column.name === 'deleted_at')) {
        db.exec('ALTER TABLE staff ADD COLUMN deleted_at INTEGER');
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, Date.now());
    });
    migrate();
  }

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
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') {
        throw new Error('Invalid product record; cursor was not saved.');
      }
      upsert.run({
        id: p.id, name: p.name, sku: p.sku ?? null, barcode: p.barcode ?? null,
        category: p.category ?? null, price: Number(p.price ?? 0), cost: p.cost ?? null,
        stockAlert: p.stockAlert ?? p.stock_alert ?? null,
        isActive: p.isActive === false || p.is_active === false ? 0 : 1,
        createdAt: p.createdAt ?? p.created_at ?? null,
        updatedAt: p.updatedAt ?? p.updated_at ?? null,
        deletedAt: p.deletedAt ?? p.deleted_at ?? null,
        lastKnownSyncSeq: Number(p.lastKnownSyncSeq ?? p.last_known_sync_seq ?? p.sync_seq ?? 0),
      });
      upserted++;
    }
    for (const p of changes.deleted || []) {
      if (!p || typeof p.id !== 'string') {
        throw new Error('Invalid product deletion; cursor was not saved.');
      }
      db.prepare('UPDATE products SET deleted_at = ?, last_known_sync_seq = ? WHERE id = ?')
        .run(p.deletedAt ?? p.deleted_at ?? Date.now(), Number(p.lastKnownSyncSeq ?? p.last_known_sync_seq ?? p.sync_seq ?? 0), p.id);
    }
    return upserted;
  });
  return apply(productChanges || {});
}


function getCursor(db) {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = 'pull_cursor'").get();
  const cursor = row ? Number(row.value) : 0;
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function applyPulledPage(db, response) {
  if (!response || !response.changes || typeof response.timestamp !== 'number' ||
      !Number.isSafeInteger(response.timestamp) || response.timestamp < 0) {
    throw new Error('Invalid pull page; cursor was not saved.');
  }

  const changes = response.changes;
  if (response.timestamp < getCursor(db)) {
    throw new Error('Pull cursor moved backwards; cursor was not saved.');
  }
  const upsertEntity = db.prepare(`
    INSERT INTO synced_entities (entity_type, id, payload_json, deleted_at, last_known_sync_seq)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, id) DO UPDATE SET
      payload_json = excluded.payload_json,
      deleted_at = excluded.deleted_at,
      last_known_sync_seq = excluded.last_known_sync_seq
    WHERE excluded.last_known_sync_seq >= synced_entities.last_known_sync_seq
  `);
  const state = db.prepare(`
    INSERT INTO sync_state(key, value) VALUES ('pull_cursor', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);


  const upsertStaff = db.prepare(`
    INSERT INTO staff (
      id, display_name, role, is_active, pin_hash, created_at, updated_at, deleted_at, last_known_sync_seq
    ) VALUES (
      @id, @displayName, @role, @isActive, NULL, @createdAt, @updatedAt, @deletedAt, @lastKnownSyncSeq
    )
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      role = excluded.role,
      is_active = excluded.is_active,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      last_known_sync_seq = excluded.last_known_sync_seq
    WHERE excluded.last_known_sync_seq >= staff.last_known_sync_seq
      AND NOT EXISTS (SELECT 1 FROM outbox WHERE entity_type = 'staff' AND entity_id = excluded.id)
  `);
  const upsertCashSession = db.prepare(`
    INSERT INTO cash_sessions (
      id, staff_id, terminal_label, opened_at, closed_at, opening_amount, closing_amount,
      expected_amount, difference, status, notes, reconciled_expected_amount,
      reconciled_difference, reconciled_at, reconciliation_alert, reconciliation_alert_reason,
      created_at, updated_at, last_known_sync_seq
    ) VALUES (
      @id, @staffId, @terminalLabel, @openedAt, @closedAt, @openingAmount, @closingAmount,
      @expectedAmount, @difference, @status, @notes, @reconciledExpectedAmount,
      @reconciledDifference, @reconciledAt, @reconciliationAlert, @reconciliationAlertReason,
      @createdAt, @updatedAt, @lastKnownSyncSeq
    )
    ON CONFLICT(id) DO UPDATE SET
      staff_id = excluded.staff_id,
      terminal_label = excluded.terminal_label,
      opened_at = excluded.opened_at,
      closed_at = excluded.closed_at,
      opening_amount = excluded.opening_amount,
      closing_amount = excluded.closing_amount,
      expected_amount = excluded.expected_amount,
      difference = excluded.difference,
      status = excluded.status,
      notes = excluded.notes,
      reconciled_expected_amount = excluded.reconciled_expected_amount,
      reconciled_difference = excluded.reconciled_difference,
      reconciled_at = excluded.reconciled_at,
      reconciliation_alert = excluded.reconciliation_alert,
      reconciliation_alert_reason = excluded.reconciliation_alert_reason,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      last_known_sync_seq = excluded.last_known_sync_seq
    WHERE excluded.last_known_sync_seq >= cash_sessions.last_known_sync_seq
      AND NOT EXISTS (SELECT 1 FROM outbox WHERE entity_type = 'cash_sessions' AND entity_id = excluded.id)
  `);

  const apply = db.transaction(() => {
    let productsProcessed = applyPulledProducts(db, changes.products || {});
    const buckets = [
      'check_ins', 'missions', 'sites', 'staff', 'cash_sessions',
      'sales', 'sale_lines', 'stock_movements',
    ];

    for (const entityType of buckets) {
      const bucket = changes[entityType] || {};

      // Persist reference entities in their queryable local tables as well as the raw sync cache.
      if (entityType === 'staff') {
        for (const item of [...(bucket.created || []), ...(bucket.updated || []), ...(bucket.deleted || [])]) {
          if (!item || typeof item.id !== 'string') throw new Error('Invalid staff record; cursor was not saved.');
          const displayName = item.displayName ?? item.display_name ?? item.name;
          const role = item.role ?? item.staff_role;
          if (typeof displayName !== 'string' || !displayName.trim() || typeof role !== 'string' || !role) {
            throw new Error('Invalid staff reference fields; cursor was not saved.');
          }
          const seq = Number(item.lastKnownSyncSeq ?? item.last_known_sync_seq ?? item.sync_seq ?? 0);
          upsertStaff.run({
            id: item.id,
            displayName,
            role,
            isActive: item.deletedAt != null || item.deleted_at != null || item.isActive === false || item.is_active === false ? 0 : 1,
            createdAt: Number(item.createdAt ?? item.created_at ?? 0),
            updatedAt: Number(item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at ?? 0),
            deletedAt: item.deletedAt ?? item.deleted_at ?? null,
            lastKnownSyncSeq: Number.isSafeInteger(seq) && seq >= 0 ? seq : 0,
          });
        }
      }

      if (entityType === 'cash_sessions') {
        for (const item of [...(bucket.created || []), ...(bucket.updated || [])]) {
          if (!item || typeof item.id !== 'string') throw new Error('Invalid cash session record; cursor was not saved.');
          const staffId = item.staffId ?? item.staff_id ?? item.cash_staff_id;
          const openedAt = item.openedAt ?? item.opened_at;
          const openingAmount = item.openingAmount ?? item.opening_amount;
          if (typeof staffId !== 'string' || openedAt == null || openingAmount == null) {
            throw new Error('Invalid cash session reference fields; cursor was not saved.');
          }
          const seq = Number(item.lastKnownSyncSeq ?? item.last_known_sync_seq ?? item.sync_seq ?? 0);
          const nullableNumber = (value) => value == null ? null : Number(value);
          upsertCashSession.run({
            id: item.id,
            staffId,
            terminalLabel: item.terminalLabel ?? item.terminal_label ?? null,
            openedAt: Number(openedAt),
            closedAt: nullableNumber(item.closedAt ?? item.closed_at),
            openingAmount: Number(openingAmount),
            closingAmount: nullableNumber(item.closingAmount ?? item.closing_amount),
            expectedAmount: nullableNumber(item.expectedAmount ?? item.expected_amount),
            difference: nullableNumber(item.difference),
            status: item.status ?? item.session_status ?? 'open',
            notes: item.notes ?? null,
            reconciledExpectedAmount: nullableNumber(item.reconciledExpectedAmount ?? item.reconciled_expected_amount),
            reconciledDifference: nullableNumber(item.reconciledDifference ?? item.reconciled_difference),
            reconciledAt: nullableNumber(item.reconciledAt ?? item.reconciled_at),
            reconciliationAlert: (item.reconciliationAlert ?? item.reconciliation_alert) == null ? null : ((item.reconciliationAlert ?? item.reconciliation_alert) ? 1 : 0),
            reconciliationAlertReason: item.reconciliationAlertReason ?? item.reconciliation_alert_reason ?? null,
            createdAt: Number(item.createdAt ?? item.created_at ?? openedAt),
            updatedAt: Number(item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at ?? openedAt),
            lastKnownSyncSeq: Number.isSafeInteger(seq) && seq >= 0 ? seq : 0,
          });
        }
      }

      for (const item of [...(bucket.created || []), ...(bucket.updated || [])]) {
        if (!item || typeof item.id !== 'string') {
          throw new Error(`Invalid ${entityType} record; cursor was not saved.`);
        }
        const seq = Number(item.lastKnownSyncSeq ?? item.last_known_sync_seq ?? item.sync_seq ?? 0);
        upsertEntity.run(entityType, item.id, JSON.stringify(item), null,
          Number.isSafeInteger(seq) && seq >= 0 ? seq : 0);
      }
      for (const item of (bucket.deleted || [])) {
        const id = typeof item === 'string' ? item : item?.id;
        if (typeof id !== 'string') throw new Error(`Invalid ${entityType} deletion; cursor was not saved.`);
        const seq = Number(item && typeof item === 'object'
          ? (item.lastKnownSyncSeq ?? item.sync_seq ?? response.timestamp)
          : response.timestamp);
        const safeSeq = Number.isSafeInteger(seq) && seq >= 0 ? seq : response.timestamp;
        const deletedAt = item && typeof item === 'object'
          ? (item.deletedAt ?? item.deleted_at ?? Date.now())
          : Date.now();
        const tombstone = item && typeof item === 'object' ? item : { id };
        upsertEntity.run(entityType, id, JSON.stringify(tombstone), deletedAt, safeSeq);
      }
    }

    // Cursor and every entity in this page commit in one SQLite transaction.
    // A crash or invalid record rolls the entire page back.
    state.run(String(response.timestamp));
    return productsProcessed;
  });

  return apply();
}


function listLocalProducts(db, { search = '' } = {}) {
  const term = String(search || '').trim();
  return db.prepare(`
    SELECT p.id, p.name, p.sku, p.barcode, p.category, p.price, p.cost,
           p.stock_alert AS stockAlert, p.is_active AS isActive,
           SUM(sm.quantity_delta) AS stockQuantity,
           p.updated_at AS updatedAt
    FROM products p
    LEFT JOIN stock_movements sm ON sm.product_id = p.id
    WHERE p.deleted_at IS NULL AND p.is_active = 1
      AND (? = '' OR p.name LIKE ? OR COALESCE(p.sku, '') LIKE ? OR COALESCE(p.barcode, '') LIKE ?)
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE
    LIMIT 500
  `).all(term, `%${term}%`, `%${term}%`, `%${term}%`).map((p) => ({
    ...p,
    price: Number(p.price),
    cost: p.cost == null ? null : Number(p.cost),
    stockAlert: p.stockAlert == null ? null : Number(p.stockAlert),
    isActive: Boolean(p.isActive),
    stockQuantity: p.stockQuantity == null ? null : Number(p.stockQuantity),
    updatedAt: p.updatedAt == null ? null : Number(p.updatedAt),
  }));
}

function saveLocalProduct(db, input, now = Date.now()) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 200) throw new Error('Le nom du produit est obligatoire (200 caractères maximum).');
  const price = Number(input.price);
  if (!Number.isSafeInteger(price) || price < 0) throw new Error('Le prix doit être un montant entier positif ou nul en CDF.');
  const cost = input.cost === '' || input.cost == null ? null : Number(input.cost);
  if (cost != null && (!Number.isSafeInteger(cost) || cost < 0)) throw new Error('Le coût doit être un montant entier positif ou nul en CDF.');
  const stockAlert = input.stockAlert === '' || input.stockAlert == null ? 5 : Number(input.stockAlert);
  if (!Number.isSafeInteger(stockAlert) || stockAlert < 0) throw new Error('Le seuil d’alerte doit être un entier positif ou nul.');
  const cleanOptional = (value, max, label) => {
    const result = typeof value === 'string' ? value.trim() : '';
    if (result.length > max) throw new Error(`${label} ne peut pas dépasser ${max} caractères.`);
    return result || null;
  };
  const sku = cleanOptional(input.sku, 64, 'La référence');
  const barcode = cleanOptional(input.barcode, 128, 'Le code-barres');
  const category = cleanOptional(input.category, 100, 'La catégorie');
  const id = typeof input.id === 'string' && input.id ? input.id : require('node:crypto').randomUUID();
  const existing = db.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
  const operation = existing && !db.prepare("SELECT 1 FROM outbox WHERE entity_type = 'products' AND entity_id = ? AND operation = 'create'").get(id)
    ? 'update' : 'create';
  const product = {
    id, name, sku, barcode, category, price, cost, stockAlert,
    isActive: true, createdAt: now, updatedAt: now, lastKnownSyncSeq: 0,
  };
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO products (id, name, sku, barcode, category, price, cost, stock_alert, is_active, created_at, updated_at, deleted_at, last_known_sync_seq)
      VALUES (@id, @name, @sku, @barcode, @category, @price, @cost, @stockAlert, 1, @createdAt, @updatedAt, NULL, 0)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, sku=excluded.sku, barcode=excluded.barcode, category=excluded.category,
        price=excluded.price, cost=excluded.cost, stock_alert=excluded.stock_alert,
        is_active=1, updated_at=excluded.updated_at, deleted_at=NULL
    `).run(product);
    const { enqueueOutbox } = require('../sync/outbox.cjs');
    enqueueOutbox(db, { entityType: 'products', entityId: id, operation, payload: product, now });
  });
  save();
  return db.prepare(`
    SELECT id, name, sku, barcode, category, price, cost, stock_alert AS stockAlert,
           is_active AS isActive, updated_at AS updatedAt
    FROM products WHERE id = ?
  `).get(id);
}

function getDashboardSummary(db) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const products = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN stock.total_stock IS NOT NULL AND stock.total_stock <= COALESCE(p.stock_alert, 5) THEN 1 ELSE 0 END) AS lowStock
    FROM products p
    LEFT JOIN (
      SELECT product_id, SUM(quantity_delta) AS total_stock
      FROM stock_movements GROUP BY product_id
    ) stock ON stock.product_id = p.id
    WHERE p.deleted_at IS NULL AND p.is_active = 1
  `).get();
  const sales = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
    FROM sales WHERE created_at >= ? AND is_void = 0
  `).get(todayStart.getTime());
  const sessions = db.prepare("SELECT COUNT(*) AS open FROM cash_sessions WHERE status = 'open' AND closed_at IS NULL").get();
  const pending = db.prepare('SELECT COUNT(*) AS total FROM outbox').get();
  return {
    products: Number(products.total || 0),
    lowStock: Number(products.lowStock || 0),
    salesToday: Number(sales.count || 0),
    salesTotalToday: Number(sales.total || 0),
    openSessions: Number(sessions.open || 0),
    pendingSync: Number(pending.total || 0),
  };
}

function resetCursor(db) {
  db.prepare("DELETE FROM sync_state WHERE key = 'pull_cursor'").run();
}

module.exports = { openDatabase, applyPulledProducts, applyPulledPage, getCursor, resetCursor, listLocalProducts, saveLocalProduct, getDashboardSummary };
