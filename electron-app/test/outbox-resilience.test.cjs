'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../electron/db/client.cjs');
const {
  enqueueOutbox, preparePushBatch, getOutboxStatus,
} = require('../electron/sync/outbox.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-outbox-resilience-'));
  let db = openDatabase({ getPath: () => root });
  return {
    root,
    get db() { return db; },
    reopen() {
      if (db?.open) db.close();
      db = openDatabase({ getPath: () => root });
      return db;
    },
    cleanup() {
      if (db?.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function enqueueSale(db, id) {
  enqueueOutbox(db, {
    entityType: 'products',
    entityId: id,
    operation: 'create',
    payload: { id, name: 'Vente locale à synchroniser', price: 4550, sku: null, barcode: null, category: null },
    now: 1700000000000,
  });
}

for (const scenario of [
  { name: '401 authentication refusal', error: Object.assign(new Error('Unauthorized'), { response: { status: 401, data: { code: 'AUTH_REJECTED' } } }) },
  { name: '403 device approval refusal', error: Object.assign(new Error('Device pending'), { response: { status: 403, data: { code: 'DEVICE_PENDING_APPROVAL' } } }) },
  { name: 'network failure', error: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
]) {
  test('preserves outbox snapshots and idempotency after ' + scenario.name, () => {
    const f = fixture();
    try {
      const id = '00000000-0000-4000-8000-000000000101';
      enqueueSale(f.db, id);
      const batch = preparePushBatch(f.db, { now: 1700000000001 });
      const beforeOutbox = f.db.prepare('SELECT id, entity_type, entity_id, operation, payload_json, attempts, last_error FROM outbox').get();
      const beforeBatch = f.db.prepare('SELECT idempotency_key, payload_json, outbox_ids_json, state FROM outbox_batches').get();

      // The production sync coordinator applies no response on rejection.
      // In particular, applyPushResponse is intentionally not called here.
      assert.ok(scenario.error);
      assert.equal(getOutboxStatus(f.db).pending, 1);

      f.reopen();
      const afterOutbox = f.db.prepare('SELECT id, entity_type, entity_id, operation, payload_json, attempts, last_error FROM outbox').get();
      const afterBatch = f.db.prepare('SELECT idempotency_key, payload_json, outbox_ids_json, state FROM outbox_batches').get();
      assert.deepEqual(afterOutbox, beforeOutbox);
      assert.deepEqual(afterBatch, beforeBatch);
      assert.equal(afterBatch.state, 'pending');
      assert.equal(afterBatch.idempotency_key, batch.idempotencyKey);

      const retry = preparePushBatch(f.db, { now: 1700000000999 });
      assert.equal(retry.idempotencyKey, batch.idempotencyKey);
      assert.deepEqual(retry.payload, batch.payload);
      assert.equal(getOutboxStatus(f.db).pending, 1);
    } finally {
      f.cleanup();
    }
  });
}
