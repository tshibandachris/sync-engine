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

test('a new empty local database can be bound to one tenant and keeps the binding after restart', () => {
  const f = fixture();
  try {
    assert.equal(hasLocalBusinessData(f.db), false);
    assert.deepEqual(bindTenant(f.db, 'tenant-a'), { bound: true, tenantId: 'tenant-a' });
    f.reopen();
    assert.deepEqual(assertTenantBinding(f.db, 'tenant-a'), { bound: true, tenantId: 'tenant-a' });
  } finally {
    f.cleanup();
  }
});

test('a database already bound to another tenant refuses the new identity without deleting data', () => {
  const f = fixture();
  try {
    bindTenant(f.db, 'tenant-a');
    f.db.prepare('INSERT INTO products(id, name, price) VALUES (?, ?, ?)').run('p1', 'Cahier', 500);
    assert.throws(
      () => assertTenantBinding(f.db, 'tenant-b'),
      (error) => error.code === 'LOCAL_TENANT_MISMATCH',
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1);
    assert.equal(f.db.prepare('SELECT tenant_id FROM device_binding WHERE singleton = 1').get().tenant_id, 'tenant-a');
  } finally {
    f.cleanup();
  }
});

test('an unbound database containing local work cannot be assigned during a fresh enrollment', () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO products(id, name, price) VALUES (?, ?, ?)').run('p1', 'Cahier', 500);
    assert.equal(hasLocalBusinessData(f.db), true);
    assert.throws(
      () => bindTenant(f.db, 'tenant-a'),
      (error) => error.code === 'LOCAL_TENANT_UNBOUND_WITH_DATA',
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM device_binding').get().n, 0);
  } finally {
    f.cleanup();
  }
});

test('an existing encrypted device identity can migrate a legacy database without resetting its offline data', () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO products(id, name, price) VALUES (?, ?, ?)').run('legacy-product', 'Stock local', 700);
    bindTenant(f.db, 'tenant-legacy', { allowLegacyMigration: true });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1);
    assert.equal(assertTenantBinding(f.db, 'tenant-legacy').bound, true);
    assert.throws(
      () => assertTenantBinding(f.db, 'tenant-other'),
      (error) => error.code === 'LOCAL_TENANT_MISMATCH',
    );
  } finally {
    f.cleanup();
  }
});
