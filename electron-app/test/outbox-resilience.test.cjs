'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../electron/db/client.cjs');
const { pushPendingBatch } = require('../electron/sync/sync-coordinator.cjs');
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

function createDeviceKeyPair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const scenarios = [
  {
    name: '401 authentication refusal',
    expectedStatus: 401,
    expectedCode: 'AUTH_REJECTED',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ code: 'AUTH_REJECTED' }),
    }),
  },
  {
    name: '403 device approval refusal',
    expectedStatus: 403,
    expectedCode: 'DEVICE_PENDING_APPROVAL',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ code: 'DEVICE_PENDING_APPROVAL' }),
    }),
  },
  {
    name: 'network failure',
    expectedCode: 'ECONNREFUSED',
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
  },
];

for (const scenario of scenarios) {
  test('preserves outbox snapshots and idempotency after ' + scenario.name, async () => {
    const f = fixture();
    try {
      const id = '00000000-0000-4000-8000-000000000101';
      const deviceId = '00000000-0000-4000-8000-000000000202';
      const { privateKey } = createDeviceKeyPair();
      enqueueSale(f.db, id);
      const batch = preparePushBatch(f.db, { now: 1700000000001 });
      const beforeOutbox = f.db.prepare(
        'SELECT id, entity_type, entity_id, operation, payload_json, attempts, last_error FROM outbox',
      ).get();
      const beforeBatch = f.db.prepare(
        'SELECT idempotency_key, payload_json, outbox_ids_json, state FROM outbox_batches',
      ).get();

      let fetchCalls = 0;
      let capturedRequest;
      const fetchImpl = async (url, options) => {
        fetchCalls += 1;
        capturedRequest = { url, options };
        return scenario.fetchImpl(url, options);
      };

      const request = pushPendingBatch({
        db: f.db,
        baseUrl: 'http://127.0.0.1:3000',
        token: 'test-agent-jwt',
        deviceId,
        privateKeyPem: privateKey,
        fetchImpl,
      });

      await assert.rejects(request, (error) => {
        if (scenario.expectedStatus !== undefined) {
          assert.equal(error.status, scenario.expectedStatus);
          assert.equal(error.code, scenario.expectedCode);
        } else {
          assert.equal(error.code, scenario.expectedCode);
        }
        return true;
      });

      // These assertions prove the HTTP boundary was actually reached with a
      // valid device identity and a freshly generated ES256 proof.
      assert.equal(fetchCalls, 1);
      assert.equal(capturedRequest.url, 'http://127.0.0.1:3000/sync/push');
      assert.equal(capturedRequest.options.method, 'POST');
      assert.equal(capturedRequest.options.headers['x-device-id'], deviceId);
      assert.match(capturedRequest.options.headers['x-device-proof'], /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      assert.equal(capturedRequest.options.headers.authorization, 'Bearer test-agent-jwt');
      assert.equal(capturedRequest.options.headers['Idempotency-Key'], batch.idempotencyKey);

      assert.equal(getOutboxStatus(f.db).pending, 1);
      f.reopen();
      const afterOutbox = f.db.prepare(
        'SELECT id, entity_type, entity_id, operation, payload_json, attempts, last_error FROM outbox',
      ).get();
      const afterBatch = f.db.prepare(
        'SELECT idempotency_key, payload_json, outbox_ids_json, state FROM outbox_batches',
      ).get();
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

test('acknowledges the Outbox only after a valid successful HTTP response', async () => {
  const f = fixture();
  try {
    const id = '00000000-0000-4000-8000-000000000303';
    const deviceId = '00000000-0000-4000-8000-000000000404';
    const { privateKey } = createDeviceKeyPair();
    enqueueSale(f.db, id);
    const batch = preparePushBatch(f.db, { now: 1700000001000 });
    let fetchCalls = 0;

    const result = await pushPendingBatch({
      db: f.db,
      baseUrl: 'http://127.0.0.1:3000',
      token: 'test-agent-jwt',
      deviceId,
      privateKeyPem: privateKey,
      fetchImpl: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({
            applied: true,
            conflicts: [],
            products: [{ entity_id: id, status: 'applied' }],
          }),
        };
      },
    });

    assert.equal(fetchCalls, 1);
    assert.deepEqual(result, { sent: true, acknowledged: 1, retained: 0, replay: false });
    assert.equal(getOutboxStatus(f.db).pending, 0);

    f.reopen();
    assert.equal(getOutboxStatus(f.db).pending, 0);
    const completed = f.db.prepare(
      'SELECT state, idempotency_key FROM outbox_batches WHERE idempotency_key = ?',
    ).get(batch.idempotencyKey);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.idempotency_key, batch.idempotencyKey);
  } finally {
    f.cleanup();
  }
});
