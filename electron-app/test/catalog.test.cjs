const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, listLocalProducts, saveLocalProduct, getDashboardSummary } = require('../electron/db/client.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-catalog-'));
  const db = openDatabase({ getPath: () => root });
  return {
    db,
    cleanup() { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('creates a local product and queues it for synchronization', () => {
  const f = fixture();
  try {
    const product = saveLocalProduct(f.db, {
      name: 'Cahier 200 pages', price: '2500', cost: '1800',
      sku: 'CAH-200', barcode: '123456', category: 'Papeterie', stockAlert: '5',
    }, 1000);

    assert.equal(product.name, 'Cahier 200 pages');
    assert.equal(product.price, 2500);
    assert.equal(product.cost, 1800);
    assert.ok(product.id);
    const queued = f.db.prepare("SELECT entity_type, operation, payload_json FROM outbox WHERE entity_id = ?").get(product.id);
    assert.equal(queued.entity_type, 'products');
    assert.equal(queued.operation, 'create');
    assert.equal(JSON.parse(queued.payload_json).name, 'Cahier 200 pages');
    assert.equal(listLocalProducts(f.db).length, 1);
  } finally { f.cleanup(); }
});

test('edits a product already queued for creation without making a duplicate update', () => {
  const f = fixture();
  try {
    const product = saveLocalProduct(f.db, { name: 'Cahier', price: '1000' }, 1000);
    saveLocalProduct(f.db, { id: product.id, name: 'Cahier grand format', price: '1500' }, 2000);
    const rows = f.db.prepare("SELECT operation, payload_json FROM outbox WHERE entity_type = 'products' AND entity_id = ?").all(product.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, 'create');
    assert.equal(JSON.parse(rows[0].payload_json).name, 'Cahier grand format');
    assert.equal(listLocalProducts(f.db)[0].price, 1500);
  } finally { f.cleanup(); }
});

test('edits a previously synchronized product as an update operation', () => {
  const f = fixture();
  try {
    const product = saveLocalProduct(f.db, { name: 'Stylo', price: '500' }, 1000);
    f.db.prepare("DELETE FROM outbox WHERE entity_id = ?").run(product.id);
    saveLocalProduct(f.db, { id: product.id, name: 'Stylo bleu', price: '600' }, 2000);
    const row = f.db.prepare("SELECT operation FROM outbox WHERE entity_id = ?").get(product.id);
    assert.equal(row.operation, 'update');
  } finally { f.cleanup(); }
});

test('rejects invalid amounts and does not misreport unknown stock as zero', () => {
  const f = fixture();
  try {
    assert.throws(() => saveLocalProduct(f.db, { name: 'Cahier', price: '-1' }), /prix doit être/);
    saveLocalProduct(f.db, { name: 'Cahier', price: '2500' });
    assert.equal(listLocalProducts(f.db)[0].stockQuantity, null);
    assert.equal(getDashboardSummary(f.db).lowStock, 0);
  } finally { f.cleanup(); }
});
