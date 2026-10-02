// test/cursor-gaps.spec.ts
//
// Regression test for the "cursor gaps" bug (HANDOFF: Debt / Roadmap v0.5.1).
//
// Invariant under test (independent of HOW the fix is implemented):
//   A client that pulls *between* two out-of-order commits must still receive
//   every row on a later pull. No row may be silently skipped.
//
// Scenario:
//   1. A control connection (`gate`) holds an advisory lock.
//   2. The agent pushes a check-in whose id is the "gate row". A test-only
//      BEFORE trigger (zz_test_gate, fires after trg_check_ins_incremental_sync
//      has assigned sync_seq) blocks on that lock: the transaction holds seq N
//      and cannot commit.
//   3. The SAME agent pushes a second check-in with a different
//      Idempotency-Key (two HTTP calls = two concurrent PG transactions, and
//      the per-(agent, key) advisory locks are distinct) -> seq N+1.
//      /sync/pull filters by agent_id, so both rows must belong to one agent.
//        - today (bug):          it commits immediately
//        - tenant-level lock fix: it waits for the first push
//   4. The client pulls in between; the gate is released; agent 1 commits.
//   5. The client pulls again from the cursor obtained at step 4.
//   6. Assert that both rows were delivered across the two pulls.
//
// Expected today: RED (row N is lost). After the v0.5.1 fix: GREEN.
// A raw `xmin` cursor, or an outbox numbered by an unlocked sequence, must
// also stay RED.
//
// Sections marked ADAPT rely on details I have not seen (seed columns).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { AddressInfo } from 'node:net';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET } from './helpers/jwt.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { SyncController } from '../src/sync.controller.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';

const GATE_KEY = 424242;
const GATE_ROW_ID = '00000000-0000-4000-8000-00000000a11e';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 10_000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
}

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

// ---------------------------------------------------------------------------
// Control test: proves the PostgreSQL premise with two raw connections.
// (Always green. It documents WHY the bug exists; the real test is below.)
// ---------------------------------------------------------------------------

describe('PostgreSQL premise', () => {
  it('nextval is not commit-ordered: a lower seq can become visible after a higher one', async () => {
    await pg.pool.query(`
      CREATE SEQUENCE IF NOT EXISTS probe_seq;
      CREATE TABLE IF NOT EXISTS probe (
        seq   bigint PRIMARY KEY DEFAULT nextval('probe_seq'),
        label text NOT NULL
      );`);

    const a = await pg.pool.connect();
    const b = await pg.pool.connect();
    try {
      await a.query('BEGIN');
      const rowA = await a.query(`INSERT INTO probe(label) VALUES ('A') RETURNING seq`);
      const seqA = Number(rowA.rows[0].seq); // held by an open transaction

      const rowB = await b.query(`INSERT INTO probe(label) VALUES ('B') RETURNING seq`); // autocommit
      const seqB = Number(rowB.rows[0].seq); // committed first
      expect(seqB).toBeGreaterThan(seqA);

      // The client pulls now: it only sees B and advances its cursor to seqB.
      const first = await pg.pool.query(`SELECT seq FROM probe WHERE seq > 0 ORDER BY seq`);
      expect(first.rows.map((r) => Number(r.seq))).toEqual([seqB]);
      const cursor = seqB;

      await a.query('COMMIT'); // A commits late

      // Next pull from the cursor: A (seqA < cursor) is never returned.
      const second = await pg.pool.query(`SELECT seq FROM probe WHERE seq > $1 ORDER BY seq`, [cursor]);
      expect(second.rows).toEqual([]);
      const all = await pg.pool.query(`SELECT seq FROM probe ORDER BY seq`);
      expect(all.rows.map((r) => Number(r.seq))).toEqual([seqA, seqB]); // exists, but was skipped
    } finally {
      a.release();
      b.release();
    }
  });
});

// ---------------------------------------------------------------------------
// The real regression test, through the real controller and services
// ---------------------------------------------------------------------------

describe('sync cursor gaps (out-of-order commit)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let baseUrl: string;
  let gate: PoolClient;

  const tenantId = randomUUID();
  const agentId = randomUUID();
  const siteId = randomUUID();
  const missionId = randomUUID(); // owned by agentId (mission ownership is checked on push)

  const token = () => jwt.sign({ sub: agentId, tenantId });

  const checkInRow = (id: string, missionId: string) => ({
    id,
    mission_id: missionId,
    check_in_time: 1700000000000,
    check_in_lat: 48.85,
    check_in_lng: 2.35,
    check_in_method: 'GPS',
  });

  async function http(path: string, tokenValue: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokenValue}`,
        ...headers,
      },
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

  // Idempotency-Key is mandatory on /sync/push (400 without it).
  const pushCheckIn = (tokenValue: string, row: ReturnType<typeof checkInRow>) =>
    http('/sync/push', tokenValue, { changes: { check_ins: { created: [row] } } }, { 'Idempotency-Key': randomUUID() });

  // Pull until has_more is false; return every check-in id seen and the final cursor.
  async function pullAll(tokenValue: string, from: number) {
    const ids = new Set<string>();
    let cursor = from;
    for (let i = 0; i < 100; i++) {
      const { status, json } = await http('/sync/pull', tokenValue, { last_pulled_at: cursor, limit: 500 });
      expect(status, `pull failed: ${JSON.stringify(json)}`).toBe(201);
      const ci = json.changes?.check_ins ?? { created: [], updated: [] };
      for (const row of [...(ci.created ?? []), ...(ci.updated ?? [])]) ids.add(row.id);
      cursor = json.timestamp;
      if (!json.has_more) break;
    }
    return { ids, cursor };
  }

  beforeAll(async () => {
    // Sites and missions are not pushable: seed them in SQL, with the same
    // statements as sync.http.spec.ts (keep them identical if columns change).
    await pg.pool.query(
      `INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)`,
      [siteId, tenantId, 'site-gap-test', 0, 0],
    );
    await pg.pool.query(
      `INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)`,
      [missionId, tenantId, agentId, 'mission-gap-test', siteId],
    );

    // Test-only gate: blocks a given check-in after sync_seq is assigned and before commit.
    // BEFORE triggers run alphabetically: trg_check_ins_incremental_sync < zz_test_gate.
    await pg.pool.query(`
      CREATE OR REPLACE FUNCTION zz_test_gate() RETURNS trigger AS $$
      BEGIN
        IF NEW.id::text = '${GATE_ROW_ID}' THEN
          PERFORM pg_advisory_xact_lock(${GATE_KEY});
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS zz_test_gate ON check_ins;
      CREATE TRIGGER zz_test_gate BEFORE INSERT OR UPDATE ON check_ins
        FOR EACH ROW EXECUTE FUNCTION zz_test_gate();`);

    gate = await pg.pool.connect(); // dedicated session for the session-level lock

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '30d' },
        }),
      ],
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    jwt = moduleRef.get(JwtService);
    // A real listener (not supertest on getHttpServer()): supertest closes the shared
    // server after each request, which could cut the other in-flight push.
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    gate?.release();
    await app?.close();
    await pg?.stop();
  });

  it('a client that pulls between two out-of-order commits still receives every row', async () => {
    // The client is up to date: its cursor sits after the seeded rows.
    const base = await pullAll(token(), 0);
    let cursor = base.cursor;
    const seen = new Set<string>();

    const rowBId = randomUUID();
    let pushA: ReturnType<typeof pushCheckIn> | undefined;
    let pushB: ReturnType<typeof pushCheckIn> | undefined;
    let gateHeld = false;
    const releaseGate = async () => {
      if (gateHeld) {
        await gate.query('SELECT pg_advisory_unlock($1)', [GATE_KEY]);
        gateHeld = false;
      }
    };

    try {
      // 1. Take the gate.
      await gate.query('SELECT pg_advisory_lock($1)', [GATE_KEY]);
      gateHeld = true;

      // 2. First push (the gate row): seq N assigned, then the trigger blocks.
      pushA = pushCheckIn(token(), checkInRow(GATE_ROW_ID, missionId));
      await waitFor(async () => {
        const r = await gate.query(
          `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = ${GATE_KEY}`,
        );
        return (r.rowCount ?? 0) > 0;
      });

      // 3. Second push (same agent, new Idempotency-Key): seq N+1.
      pushB = pushCheckIn(token(), checkInRow(rowBId, missionId));
      const bFinishedEarly = await Promise.race([pushB.then(() => true), sleep(1500).then(() => false)]);
      // Informational: true = B committed before A (bug scenario); false = B waited (lock-based fix).
      console.info(`[cursor-gaps] B finished while A was still open: ${bFinishedEarly}`);

      // 4. The client pulls in between.
      const mid = await pullAll(token(), cursor);
      mid.ids.forEach((id) => seen.add(id));
      cursor = mid.cursor;
    } finally {
      // 5. Release the gate so A can commit, whatever happened above.
      await releaseGate();
    }

    const [resA, resB] = await Promise.all([pushA!, pushB!]);
    // Guard against silent no-ops: both rows must really have been created.
    expect(resA.status, JSON.stringify(resA.json)).toBeLessThan(300);
    expect(resB.status, JSON.stringify(resB.json)).toBeLessThan(300);
    expect(resA.json?.applied?.created, JSON.stringify(resA.json)).toBe(1);
    expect(resB.json?.applied?.created, JSON.stringify(resB.json)).toBe(1);

    // 6. Next pull from the cursor obtained in the middle.
    const last = await pullAll(token(), cursor);
    last.ids.forEach((id) => seen.add(id));

    expect([...seen]).toEqual(expect.arrayContaining([GATE_ROW_ID, rowBId]));
  }, 60_000);
});
