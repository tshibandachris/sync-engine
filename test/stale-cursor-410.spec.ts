// test/stale-cursor-410.spec.ts
//
// Roadmap v0.5.2: 410 GONE for stale pull cursors.
//
// Rule under test (per tenant, watermark = sync_purge_state.purged_up_to_seq):
//
//   last_pulled_at == 0                        -> 2xx  (full sync, never stale)
//   0 < last_pulled_at < purged_up_to_seq      -> 410  (may have missed purged deletions)
//   last_pulled_at >= purged_up_to_seq         -> 2xx  (has seen everything that was purged)
//   no watermark row for the tenant            -> 2xx
//
// Expected before the fix: the "below the watermark" and "recovery" tests are
// RED (pull answers 200); the others are GREEN and guard against an
// over-eager implementation (for instance one that returns 410 for cursor 0,
// which would lock a client out forever, since cursor 0 is exactly what it
// must send to recover).
//
// Prerequisites:
//   - migrations/008_sync_purge_state.sql exists and is applied by the
//     TestPostgres helper (see the helper patch in the hand-off message).
//   - src/schema.ts gets the matching Drizzle table (convention: no schema
//     change without a migration).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { TEST_JWT_SECRET } from './helpers/jwt.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';
import { SyncController } from '../src/sync.controller.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';

describe('sync pull / stale cursor (410 GONE)', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let jwt: JwtService;
  let baseUrl: string;
  let maintenance: SyncMaintenanceService;

  // Tenant A owns the data. Tenant B has no data and no watermark.
  const tenantA = randomUUID();
  const agentA = randomUUID();
  const tenantB = randomUUID();
  const agentB = randomUUID();
  const siteId = randomUUID();
  const missionId = randomUUID();
  const checkIn1 = randomUUID();
  const checkIn2 = randomUUID();

  // Real sync_seq values of the two check-ins, read back from the database.
  let s1: number;
  let s2: number;

  const tokenA = () => jwt.sign({ sub: agentA, tenantId: tenantA });
  const tokenB = () => jwt.sign({ sub: agentB, tenantId: tenantB });

  const checkInRow = (id: string) => ({
    id,
    mission_id: missionId,
    check_in_time: 1700000000000,
    check_in_lat: 48.85,
    check_in_lng: 2.35,
    check_in_method: 'GPS',
  });

  async function post(path: string, tokenValue: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenValue}`, ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  const pull = (tokenValue: string, cursor: number) =>
    post('/sync/pull', tokenValue, { last_pulled_at: cursor, limit: 500 });

  const idsIn = (json: any): string[] => {
    const ci = json?.changes?.check_ins ?? {};
    return [...(ci.created ?? []), ...(ci.updated ?? [])].map((r: any) => r.id);
  };

  // Nest answers 201 to a POST by default, so /sync/pull currently returns 201.
  // "Fresh" means: any 2xx, and in particular not 410.
  const freshStatus = (res: { status: number; json: any }) => res.status >= 200 && res.status < 300;

  const expectFresh = (res: { status: number; json: any }) => {
    expect(res.status, JSON.stringify(res.json)).toBeGreaterThanOrEqual(200);
    expect(res.status, JSON.stringify(res.json)).toBeLessThan(300);
  };

  const setWatermark = (tenant: string, seq: number) =>
    pg.pool.query(
      `INSERT INTO sync_purge_state (tenant_id, purged_up_to_seq, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE
         SET purged_up_to_seq = EXCLUDED.purged_up_to_seq, updated_at = EXCLUDED.updated_at`,
      [tenant, seq, Date.now()],
    );

  beforeAll(async () => {
    pg = await startTestPostgres();

    // Same seed statements as sync.http.spec.ts.
    await pg.pool.query(
      `INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)`,
      [siteId, tenantA, 'site-410-test', 0, 0],
    );
    await pg.pool.query(
      `INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)`,
      [missionId, tenantA, agentA, 'mission-410-test', siteId],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '30d' } })],
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.db },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncMaintenanceService, useFactory: (d: any) => new SyncMaintenanceService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    jwt = moduleRef.get(JwtService);
    maintenance = moduleRef.get(SyncMaintenanceService);
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // Two real check-ins through the API, so their sync_seq values are real.
    for (const id of [checkIn1, checkIn2]) {
      const r = await post(
        '/sync/push',
        tokenA(),
        { changes: { check_ins: { created: [checkInRow(id)] } } },
        { 'Idempotency-Key': randomUUID() },
      );
      expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
      expect(r.json?.applied?.created, JSON.stringify(r.json)).toBe(1); // no silent no-op
    }

    const seqs = await pg.pool.query(
      `SELECT id, sync_seq FROM check_ins WHERE tenant_id = $1 ORDER BY sync_seq`,
      [tenantA],
    );
    expect(seqs.rows.map((r) => r.id)).toEqual([checkIn1, checkIn2]);
    s1 = Number(seqs.rows[0].sync_seq);
    s2 = Number(seqs.rows[1].sync_seq);
    // Preconditions for the scenarios below.
    expect(s1).toBeGreaterThan(1); // so that a stale cursor s1 - 1 is non-zero
    expect(s2).toBeGreaterThan(s1);
  }, 180_000);

  afterEach(async () => {
    await pg.pool.query(`DELETE FROM sync_purge_state WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  // -------------------------------------------------------------------------

  it('cursor 0 is a full sync and is never stale, even with a watermark', async () => {
    await setWatermark(tenantA, s2);

    const res = await pull(tokenA(), 0);

    expectFresh(res);
    expect(idsIn(res.json)).toEqual(expect.arrayContaining([checkIn1, checkIn2]));
  });

  it('a cursor strictly below the watermark gets 410 and no data', async () => {
    await setWatermark(tenantA, s2);
    const staleCursor = s1 - 1; // non-zero (precondition) and < s2

    const res = await pull(tokenA(), staleCursor);

    expect(res.status, JSON.stringify(res.json)).toBe(410);
    expect(res.json?.changes).toBeUndefined(); // must not leak a partial changeset
  });

  it('a cursor equal to the watermark is fresh (strict "<" boundary)', async () => {
    await setWatermark(tenantA, s1);

    const res = await pull(tokenA(), s1);

    expectFresh(res);
  });

  it('a cursor above the watermark is fresh', async () => {
    await setWatermark(tenantA, s1);

    const res = await pull(tokenA(), s2);

    expectFresh(res);
  });

  it('a tenant without a watermark row never gets 410', async () => {
    // No setWatermark call: afterEach cleared any row, so tenant A has none.
    const res = await pull(tokenA(), s1 - 1);

    expectFresh(res);
  });

  it('the watermark is per tenant: tenant A being stale does not affect tenant B', async () => {
    await setWatermark(tenantA, s2);

    const res = await pull(tokenB(), 1);

    expectFresh(res);
  });

  it('recovery: after a 410 the client can resync from cursor 0 and then continue incrementally', async () => {
    await setWatermark(tenantA, s2);

    // 1. The stale client is told to start over.
    const stale = await pull(tokenA(), s1 - 1);
    expect(stale.status, JSON.stringify(stale.json)).toBe(410);

    // 2. Full resync from scratch.
    const full = await pull(tokenA(), 0);
    expectFresh(full);
    expect(idsIn(full.json)).toEqual(expect.arrayContaining([checkIn1, checkIn2]));

    // 3. The cursor it receives must not itself be stale, or the client would
    //    loop on 410 forever.
    const newCursor = Number(full.json.timestamp);
    expect(newCursor).toBeGreaterThanOrEqual(s2);

    // 4. Incremental pull from the new cursor works.
    const next = await pull(tokenA(), newCursor);
    expectFresh(next);
  });

  // ---------------------------------------------------------------------------
  // Purge side (v0.5.3)
  // ---------------------------------------------------------------------------

  const oldDeletedAt = () => Date.now() - 40 * 24 * 3600 * 1000;

  it('purge sets purged_up_to_seq to the highest sync_seq among the tombstones it removed, in the same transaction', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    for (const id of [c1, c2]) {
      const r = await post('/sync/push', tokenA(), { changes: { check_ins: { created: [checkInRow(id)] } } }, { 'Idempotency-Key': randomUUID() });
      expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
    }

    // Soft-delete both with an old deleted_at so they qualify for purge
    const ts = oldDeletedAt();
    await pg.pool.query('UPDATE check_ins SET deleted_at = $1 WHERE id = ANY($2::uuid[])', [ts, [c1, c2]]);

    const seqs = await pg.pool.query('SELECT sync_seq FROM check_ins WHERE id = ANY($1::uuid[])', [[c1, c2]]);
    const maxSeq = Math.max(...seqs.rows.map((r: any) => Number(r.sync_seq)));

    const result = await maintenance.purgeTenantTombstones(tenantA, 30);

    expect(result.checkInsDeleted).toBe(2);
    expect(result.purgedUpToSeq).toBe(maxSeq);

    const wm = await pg.pool.query('SELECT purged_up_to_seq FROM sync_purge_state WHERE tenant_id = $1', [tenantA]);
    expect(Number(wm.rows[0].purged_up_to_seq)).toBe(maxSeq);

    const remaining = await pg.pool.query('SELECT id FROM check_ins WHERE id = ANY($1::uuid[])', [[c1, c2]]);
    expect(remaining.rows).toHaveLength(0);
  });

  it('purged_up_to_seq never decreases (GREATEST on update)', async () => {
    await setWatermark(tenantA, 1000);

    const c1 = randomUUID();
    await post('/sync/push', tokenA(), { changes: { check_ins: { created: [checkInRow(c1)] } } }, { 'Idempotency-Key': randomUUID() });
    await pg.pool.query('UPDATE check_ins SET deleted_at = $1 WHERE id = $2', [oldDeletedAt(), c1]);

    const result = await maintenance.purgeTenantTombstones(tenantA, 30);

    expect(result.purgedUpToSeq).toBe(1000);

    const wm = await pg.pool.query('SELECT purged_up_to_seq FROM sync_purge_state WHERE tenant_id = $1', [tenantA]);
    expect(Number(wm.rows[0].purged_up_to_seq)).toBe(1000);
  });

  it('a purge that removes nothing leaves the watermark unchanged', async () => {
    await setWatermark(tenantA, 1000);

    const result = await maintenance.purgeTenantTombstones(tenantA, 30);

    expect(result.checkInsDeleted).toBe(0);
    expect(result.purgedUpToSeq).toBe(1000);
  });

  it('a pull racing with a purge cannot miss deletions', async () => {
    const c1 = randomUUID();
    const r = await post('/sync/push', tokenA(), { changes: { check_ins: { created: [checkInRow(c1)] } } }, { 'Idempotency-Key': randomUUID() });
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);

    const before = await pg.pool.query('SELECT sync_seq FROM check_ins WHERE id = $1', [c1]);
    const seqBeforeDelete = Number(before.rows[0].sync_seq);

    await pg.pool.query('UPDATE check_ins SET deleted_at = $1 WHERE id = $2', [oldDeletedAt(), c1]);
    const after = await pg.pool.query('SELECT sync_seq FROM check_ins WHERE id = $1', [c1]);
    const seqAfterDelete = Number(after.rows[0].sync_seq);
    expect(seqAfterDelete).toBeGreaterThan(seqBeforeDelete);

    const purgeResult = await maintenance.purgeTenantTombstones(tenantA, 30);
    expect(purgeResult.purgedUpToSeq).toBe(seqAfterDelete);

    // A client whose cursor predates the deletion is told to resync.
    const stalePull = await pull(tokenA(), seqBeforeDelete);
    expect(stalePull.status).toBe(410);
    expect(stalePull.json?.changes).toBeUndefined();

    // Resync from scratch: the deletion is reflected (c1 is gone, no tombstone).
    const fullPull = await pull(tokenA(), 0);
    expect(freshStatus(fullPull));
    expect(idsIn(fullPull.json)).not.toContain(c1);
  });
});
