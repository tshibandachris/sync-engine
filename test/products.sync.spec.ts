import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Products sync / integration', () => {
  let pg: TestPostgres;
  let push: SyncPushService;
  let pull: SyncPullService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    push = new SyncPushService(pg.appDb);
    pull = new SyncPullService(pg.appDb);
  }, 120_000);

  afterAll(async () => { await pg.stop(); });

  beforeEach(async () => {
    await pg.pool.query('TRUNCATE products, check_ins, missions, sites, sync_idempotency_keys, sync_conflicts RESTART IDENTITY CASCADE');
    await pg.pool.query('ALTER SEQUENCE global_sync_seq RESTART WITH 1');
  });

  function product(overrides: Record<string, unknown> = {}) {
    return { id: randomUUID(), name: 'Cahier A4', sku: 'CAH-A4', barcode: '1234567890123',
      category: 'Papeterie', price: 2500, cost: 1500, stockAlert: 5, isActive: true,
      createdAt: 1_790_000_000_000, deletedAt: null, lastKnownSyncSeq: 0, ...overrides };
  }
  async function sendProduct(p: Record<string, unknown>, tenantId = tenantA) {
    return push.pushChanges(agentId, { changes: { products: [p as any] } }, undefined, tenantId);
  }

  it('creates a product and lets the trigger assign sync_seq', async () => {
    const p = product();
    const res = await sendProduct(p);
    expect(res.products?.[0].status).toBe('applied');
    expect(res.products?.[0].sync_seq).toBeGreaterThan(0);
    const row = await pg.pool.query('SELECT sync_seq, first_sync_seq, updated_at, created_at FROM products WHERE id = $1', [p.id]);
    expect(Number(row.rows[0].sync_seq)).toBe(Number(res.products?.[0].sync_seq));
    expect(Number(row.rows[0].first_sync_seq)).toBe(Number(row.rows[0].sync_seq));
    expect(Number(row.rows[0].created_at)).toBe(p.createdAt);
    expect(Number(row.rows[0].updated_at)).not.toBe(p.createdAt);
  });

  it('treats an identical retry as idempotent without duplicating the row', async () => {
    const p = product();
    expect((await sendProduct(p)).products?.[0].status).toBe('applied');
    expect((await sendProduct(p)).products?.[0].status).toBe('idempotent');
    const count = await pg.pool.query('SELECT count(*)::int AS n FROM products WHERE id = $1', [p.id]);
    expect(count.rows[0].n).toBe(1);
  });

  it('updates only when lastKnownSyncSeq matches the server sequence', async () => {
    const p = product();
    const created = await sendProduct(p);
    const seq = created.products?.[0].sync_seq!;
    const updated = await sendProduct({ ...p, price: 2800, lastKnownSyncSeq: seq });
    expect(updated.products?.[0].status).toBe('applied');
    const row = await pg.pool.query('SELECT price, sync_seq FROM products WHERE id = $1', [p.id]);
    expect(row.rows[0].price).toBe(2800);
    expect(Number(row.rows[0].sync_seq)).toBeGreaterThan(Number(seq));
  });

  it('returns conflict for a stale update with different business fields', async () => {
    const p = product();
    const created = await sendProduct(p);
    const seq = created.products?.[0].sync_seq!;
    await sendProduct({ ...p, price: 2800, lastKnownSyncSeq: seq });
    const stale = await sendProduct({ ...p, price: 3000, lastKnownSyncSeq: seq });
    expect(stale.products?.[0].status).toBe('conflict');
    expect(stale.products?.[0].sync_seq).toBeGreaterThan(Number(seq));
    const row = await pg.pool.query('SELECT price FROM products WHERE id = $1', [p.id]);
    expect(row.rows[0].price).toBe(2800);
  });

  it('does not allow one tenant to overwrite another tenant product', async () => {
    const p = product();
    expect((await sendProduct(p, tenantB)).products?.[0].status).toBe('applied');
    const attempt = await sendProduct({ ...p, price: 9999 }, tenantA);
    expect(attempt.products?.[0].status).toBe('conflict');
    const row = await pg.pool.query('SELECT tenant_id, price FROM products WHERE id = $1', [p.id]);
    expect(row.rows[0].tenant_id).toBe(tenantB);
    expect(row.rows[0].price).toBe(p.price);
  });

  it('pulls products in shared sync_seq order and resumes after a cursor', async () => {
    const p1 = product({ name: 'Produit 1' });
    const p2 = product({ name: 'Produit 2' });
    const p3 = product({ name: 'Produit 3' });
    await sendProduct(p1);
    const r2 = await sendProduct(p2);
    await sendProduct(p3);
    const all = await pull.pullChanges({ agentId, tenantId: tenantA, lastPulledAt: 0, limit: 100 });
    expect(all.changes.products.created.map((p: any) => p.id)).toEqual([p1.id, p2.id, p3.id]);
    const afterTwo = await pull.pullChanges({ agentId, tenantId: tenantA, lastPulledAt: Number(r2.products?.[0].sync_seq), limit: 100 });
    expect(afterTwo.changes.products.created.map((p: any) => p.id)).toEqual([p3.id]);
  });

  it('rejects server-owned and unknown fields instead of silently stripping them', async () => {
    for (const forbidden of ['tenant_id', 'sync_seq', 'first_sync_seq', 'updatedAt', 'updated_at']) {
      const p = product({ [forbidden]: forbidden === 'tenant_id' ? tenantB : 123 });
      const res = await sendProduct(p);
      expect(res.products?.[0].status, forbidden).toBe('invalid');
      const row = await pg.pool.query('SELECT id FROM products WHERE id = $1', [p.id]);
      expect(row.rows).toHaveLength(0);
    }
  });

  it('supports a two-device offline round trip through the shared cursor', async () => {
    // Device A creates three products while offline, then pushes them.
    const p1 = product({ name: 'Device A - 1' });
    const p2 = product({ name: 'Device A - 2' });
    const p3 = product({ name: 'Device A - 3' });
    const a1 = await sendProduct(p1);
    await sendProduct(p2);
    await sendProduct(p3);
    const deviceACursor = Number((await pull.pullChanges({
      agentId, tenantId: tenantA, lastPulledAt: 0, limit: 100,
    })).timestamp);

    // Device B pulls the same stream and edits the second product at its known version.
    const deviceBInitial = await pull.pullChanges({
      agentId, tenantId: tenantA, lastPulledAt: 0, limit: 100,
    });
    const pulledP2 = deviceBInitial.changes.products.created.find((p: any) => p.id === p2.id);
    expect(pulledP2).toBeDefined();
    const bUpdate = await sendProduct({
      ...p2,
      name: 'Device B edited product',
      price: 2750,
      lastKnownSyncSeq: Number(pulledP2.lastKnownSyncSeq),
    });
    expect(bUpdate.products?.[0].status).toBe('applied');

    // Device A resumes from its previous cursor and observes B's update.
    const deviceAResume = await pull.pullChanges({
      agentId, tenantId: tenantA, lastPulledAt: deviceACursor, limit: 100,
    });
    const updatedP2 = deviceAResume.changes.products.updated.find((p: any) => p.id === p2.id);
    expect(updatedP2).toBeDefined();
    expect(updatedP2.name).toBe('Device B edited product');
    expect(updatedP2.price).toBe(2750);
    expect(Number(deviceAResume.timestamp)).toBeGreaterThan(deviceACursor);
    expect(a1.products?.[0].status).toBe('applied');
    expect(deviceAResume.has_more).toBe(false);
  });

  it('keeps a valid check-in when a product in the same push is invalid', async () => {
    const siteId = randomUUID(), missionId = randomUUID(), checkInId = randomUUID();
    await pg.pool.query(
      "INSERT INTO sites (id, tenant_id, name, latitude, longitude, created_at, updated_at, deleted_at, sync_seq, first_sync_seq) VALUES ($1,$2,$3,0,0,1,1,NULL,nextval('global_sync_seq'),currval('global_sync_seq'))",
      [siteId, tenantA, 'Site A'],
    );
    await pg.pool.query(
      "INSERT INTO missions (id, tenant_id, agent_id, site_id, title, created_at, updated_at, deleted_at, sync_seq, first_sync_seq) VALUES ($1,$2,$3,$4,$5,1,1,NULL,nextval('global_sync_seq'),currval('global_sync_seq'))",
      [missionId, tenantA, agentId, siteId, 'Mission A'],
    );
    const res = await push.pushChanges(agentId, {
      changes: {
        check_ins: { created: [{ id: checkInId, mission_id: missionId, check_in_time: 1, check_in_lat: 0, check_in_lng: 0, check_in_method: 'GPS' }] },
        products: [product({ price: -5 }) as any],
      },
    }, undefined, tenantA);
    expect(res.applied.created).toBe(1);
    expect(res.products?.[0].status).toBe('invalid');
    const checkIn = await pg.pool.query('SELECT id FROM check_ins WHERE id = $1', [checkInId]);
    expect(checkIn.rows).toHaveLength(1);
  });
});
