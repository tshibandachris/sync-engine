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
import { SyncController } from '../src/sync.controller.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';

describe('sync pull / stale cursor (410 GONE)', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let jwt: JwtService;
  let baseUrl: string;

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
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    jwt = moduleRef.get(JwtService);
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

  // Purge side: needs the maintenance service API. Fill in once it is wired.
  it.todo('purge sets purged_up_to_seq to the highest sync_seq among the tombstones it removed, in the same transaction');
  it.todo('purged_up_to_seq never decreases (GREATEST on update)');
  it.todo('a purge that removes nothing leaves the watermark unchanged');
  it.todo('a pull racing with a purge cannot miss deletions (watermark re-checked after the data read, or one REPEATABLE READ transaction)');
});
