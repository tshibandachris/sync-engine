const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, hasLocalBusinessData, assertTenantBinding, bindTenant } = require('../electron/db/client.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-tenant-binding-'));
  const app = { getPath: () => root };
  let db = openDatabase(app);
  return {
    root,
    get db() { return db; },
    reopen() {
      if (db?.open) db.close();
      db = openDatabase(app);
      return db;
    },
    cleanup() {
      if (db?.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a new database runs tenant binding v3 and POS close schema v4', () => {
  const f = fixture();
  try {
    assert.equal(f.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
    assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_binding'").get());
    const columns = f.db.pragma('table_info(cash_sessions)');
    assert.ok(columns.some((column) => column.name === 'close_requested_at'));
    assert.ok(columns.some((column) => column.name === 'close_sync_state'));
  } finally {
    f.cleanup();
  }
});

test('an empty local database can be bound to one tenant and keeps the binding after restart', () => {
  const f = fixture();
  try {
    assert.equal(hasLocalBusinessData(f.db), false);
    assert.deepEqual(bindTenant(f.db, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), { bound: true, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    f.reopen();
    assert.deepEqual(assertTenantBinding(f.db, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), { bound: true, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  } finally {
    f.cleanup();
  }
});

test('a database bound to another tenant refuses the new identity without deleting data', () => {
  const f = fixture();
  try {
    bindTenant(f.db, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    f.db.prepare('INSERT INTO products(id, name, price) VALUES (?, ?, ?)').run('p1', 'Cahier', 500);
    assert.throws(() => assertTenantBinding(f.db, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      (error) => error.code === 'LOCAL_TENANT_MISMATCH');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1);
    assert.equal(f.db.prepare('SELECT tenant_id FROM device_binding WHERE singleton = 1').get().tenant_id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  } finally {
    f.cleanup();
  }
});

test('an unbound database containing local work cannot be assigned during fresh enrollment', () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO products(id, name, price) VALUES (?, ?, ?)').run('p1', 'Cahier', 500);
    assert.equal(hasLocalBusinessData(f.db), true);
    assert.throws(() => bindTenant(f.db, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      (error) => error.code === 'LOCAL_TENANT_UNBOUND_WITH_DATA');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM device_binding').get().n, 0);
  } finally {
    f.cleanup();
  }
});

test('tenant binding rejects non-UUID identifiers before writing local state', () => {
  const f = fixture();
  try {
    assert.throws(() => bindTenant(f.db, 'tenant-a'), /UUID absent ou invalide/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM device_binding').get().n, 0);
  } finally {
    f.cleanup();
  }
});
