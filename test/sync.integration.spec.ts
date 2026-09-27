import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService, type SyncPushDto } from '../src/sync-push.service.js';
import * as schema from '../src/schema.js';

describe('Sync Engine / sync_seq integration', () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pull: SyncPullService;
  let push: SyncPushService;

  const agentA = randomUUID();
  const agentB = randomUUID();
  const missionA = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    pool = pg.pool;
    db = drizzle(pool, { schema });
    pull = new SyncPullService(db);
    push = new SyncPushService(db);

    await pool.query('ALTER SEQUENCE global_sync_seq RESTART WITH 1');
    await pool.query('DELETE FROM check_ins');
    await pool.query('DELETE FROM missions');
    await pool.query('DELETE FROM sync_idempotency_keys');
    await pool.query('DELETE FROM sites');

    await pool.query(
      'INSERT INTO missions (id, agent_id, title) VALUES ($1, $2, $3)',
      [missionA, agentA, 'Mission A'],
    );
  });

  afterAll(async () => {
    await pg.stop();
  });

  it('paginates 1200 records in 3 batches', async () => {
    const rows = Array.from({ length: 1200 }, () => ({
      id: randomUUID(),
      missionId: missionA,
      agentId: agentA,
      checkInTime: Date.now(),
      checkInLat: 48.8566,
      checkInLng: 2.3522,
      checkInMethod: 'GPS',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
    }));

    for (let i = 0; i < rows.length; i += 400) {
      await db.insert(schema.checkIns).values(
        rows.slice(i, i + 400).map((row) => ({
          ...row,
          syncSeq: 0,
        })),
      );
    }

    let cursor: number | null = null;
    let total = 0;
    let iterations = 0;

    do {
      const result = await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: cursor,
        limit: 500,
      });

      iterations++;

      total +=
        result.changes.check_ins.created.length +
        result.changes.check_ins.updated.length;

      cursor = result.timestamp;

      if (iterations > 10) {
        throw new Error('Pagination did not converge');
      }

      if (!result.has_more) {
        break;
      }
    } while (true);

    expect(iterations).toBe(3);
    expect(total).toBe(1200);
  });

  it('performs an UPSERT create followed by a real update', async () => {
    const id = randomUUID();

    await push.pushChanges(agentA, {
      changes: {
        check_ins: {
          created: [
            {
              id,
              mission_id: missionA,
              check_in_time: 1650000000000,
              check_in_lat: 48.85,
              check_in_lng: 2.35,
              check_in_method: 'GPS',
            },
          ],
        },
      },
    });

    await push.pushChanges(agentA, {
      changes: {
        check_ins: {
          updated: [
            {
              id,
              check_out_time: 1650003600000,
            },
          ],
        },
      },
    });

    const [row] = await db
      .select()
      .from(schema.checkIns)
      .where(eq(schema.checkIns.id, id));

    expect(row.checkOutTime).toBe(1650003600000);
  });

  it('rejects an update for an unknown ID', async () => {
    await expect(
      push.pushChanges(agentA, {
        changes: {
          check_ins: {
            updated: [
              {
                id: randomUUID(),
                check_out_time: Date.now(),
              },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a soft-delete by another agent', async () => {
    const id = randomUUID();

    await db.insert(schema.checkIns).values({
      id,
      missionId: missionA,
      agentId: agentA,
      checkInTime: Date.now(),
      checkInLat: 1,
      checkInLng: 2,
      checkInMethod: 'GPS',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      syncSeq: 0,
    });

    await expect(
      push.pushChanges(agentB, {
        changes: {
          check_ins: {
            deleted: [id],
          },
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an update after soft-delete', async () => {
    const id = randomUUID();

    await db.insert(schema.checkIns).values({
      id,
      missionId: missionA,
      agentId: agentA,
      checkInTime: Date.now(),
      checkInLat: 1,
      checkInLng: 2,
      checkInMethod: 'GPS',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      syncSeq: 0,
    });

    await push.pushChanges(agentA, {
      changes: {
        check_ins: {
          deleted: [id],
        },
      },
    });

    await expect(
      push.pushChanges(agentA, {
        changes: {
          check_ins: {
            updated: [
              {
                id,
                check_out_time: Date.now(),
              },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not apply the same Idempotency-Key twice', async () => {
    const id = randomUUID();

    const dto: SyncPushDto = {
      changes: {
        check_ins: {
          created: [
            {
              id,
              mission_id: missionA,
              check_in_time: Date.now(),
              check_in_lat: 1,
              check_in_lng: 2,
              check_in_method: 'GPS',
            },
          ],
        },
      },
    };

    await push.pushChanges(agentA, dto, 'test-idempotency-1');
    await push.pushChanges(agentA, dto, 'test-idempotency-1');

    const result = await pool.query(
      'SELECT count(*)::int AS count FROM check_ins WHERE id = $1',
      [id],
    );

    expect(result.rows[0].count).toBe(1);
  });  it('does not return already-pulled changes on a subsequent call', async () => {
    const id = randomUUID();

    await push.pushChanges(agentA, {
      changes: {
        check_ins: {
          created: [
            {
              id,
              mission_id: missionA,
              check_in_time: Date.now(),
              check_in_lat: 1,
              check_in_lng: 2,
              check_in_method: 'GPS',
            },
          ],
        },
      },
    });

    let cursor: number | null = null;
    let found = false;
    let finalCursor = 0;

    while (true) {
      const result = await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: cursor,
        limit: 500,
      });

      const all = [
        ...result.changes.check_ins.created,
        ...result.changes.check_ins.updated,
      ];
      if (all.some((r: { id: string }) => r.id === id)) found = true;

      cursor = result.timestamp;
      finalCursor = cursor;
      if (!result.has_more) break;
    }

    expect(found).toBe(true);

    const empty = await pull.pullChanges({
      agentId: agentA,
      lastPulledAt: finalCursor,
      limit: 500,
    });

    expect(empty.changes.check_ins.created.length).toBe(0);
    expect(empty.changes.check_ins.updated.length).toBe(0);
  });

  it('returns missions in the pull payload for the agent', async () => {
    let cursor: number | null = null;
    let mission: { id: string } | undefined;

    while (true) {
      const result = await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: cursor,
        limit: 500,
      });

      const all = [
        ...result.changes.missions.created,
        ...result.changes.missions.updated,
      ];
      mission = all.find((m: { id: string }) => m.id === missionA);
      if (mission) break;

      cursor = result.timestamp;
      if (!result.has_more) break;
    }

    expect(mission).toBeDefined();
    expect(mission?.id).toBe(missionA);
  });

  it('routes a soft-deleted check-in to the deleted bucket', async () => {
    const id = randomUUID();

    await push.pushChanges(agentA, {
      changes: {
        check_ins: {
          created: [
            {
              id,
              mission_id: missionA,
              check_in_time: Date.now(),
              check_in_lat: 1,
              check_in_lng: 2,
              check_in_method: 'GPS',
            },
          ],
        },
      },
    });

    await push.pushChanges(agentA, {
      changes: {
        check_ins: {
          deleted: [id],
        },
      },
    });

    let cursor: number | null = null;
    const seen = { created: false, updated: false, deleted: false };

    while (true) {
      const result = await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: cursor,
        limit: 500,
      });

      if (result.changes.check_ins.created.some((r: { id: string }) => r.id === id)) {
        seen.created = true;
      }
      if (result.changes.check_ins.updated.some((r: { id: string }) => r.id === id)) {
        seen.updated = true;
      }
      if (result.changes.check_ins.deleted.includes(id)) {
        seen.deleted = true;
      }

      cursor = result.timestamp;
      if (!result.has_more) break;
    }

    expect(seen.deleted).toBe(true);
    expect(seen.created).toBe(false);
    expect(seen.updated).toBe(false);
  });
});