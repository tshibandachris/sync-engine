import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService, type SyncPushDto } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import * as schema from '../src/schema.js';

describe('Sync Engine / sync_seq integration', () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pull: SyncPullService;
  let push: SyncPushService;
  let conflict: SyncConflictService;

  const agentA = randomUUID();
  const agentB = randomUUID();
  const missionA = randomUUID();
  const siteA = randomUUID();

  beforeAll(async () => {
  pg = await startTestPostgres();
  pool = pg.pool;
  db = drizzle(pool, { schema });
  pull = new SyncPullService(db);
  push = new SyncPushService(db);
  conflict = new SyncConflictService(db);
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE check_ins, missions, sites, sync_idempotency_keys, sync_conflicts RESTART IDENTITY CASCADE',
  );

  await pool.query(
    'ALTER SEQUENCE global_sync_seq RESTART WITH 1',
  );

  await pool.query(
    'INSERT INTO sites (id, name, latitude, longitude) VALUES ($1, $2, $3, $4)',
    [siteA, 'Site A', 48.85, 2.35],
  );

  await pool.query(
    'INSERT INTO missions (id, agent_id, title, site_id) VALUES ($1, $2, $3, $4)',
    [missionA, agentA, 'Mission A', siteA],
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

    const vr1 = await pool.query('SELECT sync_seq FROM check_ins WHERE id = $1', [id]);
    const v1 = Number(vr1.rows[0].sync_seq);

    await push.pushChanges(agentA, {
      changes: {
        check_ins: {
          updated: [
            {
              id,
              version: v1,
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
                version: 1,
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
                version: 1,
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

  it('returns updated missions on a subsequent pull after modification', async () => {
    const initial = await pull.pullChanges({
      agentId: agentA,
      lastPulledAt: null,
      limit: 500,
    });

    expect(
      initial.changes.missions.created.some(
        (mission) => mission.id === missionA,
      ),
    ).toBe(true);

    const cursor = initial.timestamp;

    await pool.query(
      "UPDATE missions SET title = 'Mission A (modifiee)' WHERE id = $1",
      [missionA],
    );

    const second = await pull.pullChanges({
      agentId: agentA,
      lastPulledAt: cursor,
      limit: 500,
    });

    const updated =
      second.changes.missions.updated.find(
        (mission) => mission.id === missionA,
      );

    expect(updated).toBeDefined();

    expect(updated?.title).toBe(
      'Mission A (modifiee)',
    );

    expect(second.timestamp).toBeGreaterThan(
      cursor,
    );
  });

  it('returns updated sites when only the site changes', async () => {
    const initial = await pull.pullChanges({
      agentId: agentA,
      lastPulledAt: null,
      limit: 500,
    });

    const missionRow =
      await pool.query(
        "SELECT site_id FROM missions WHERE id = $1",
        [missionA],
      );

    const siteId =
      missionRow.rows[0]?.site_id;

    expect(siteId).toBeDefined();

    const cursor =
      initial.timestamp;

    await pool.query(
      "UPDATE sites SET name = 'Site A (modifie)' WHERE id = $1",
      [siteId],
    );

    const second =
      await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: cursor,
        limit: 500,
      });

    const updated =
      second.changes.sites.updated.find(
        (site) => site.id === siteId,
      );

    expect(updated).toBeDefined();

    expect(updated?.name).toBe(
      'Site A (modifie)',
    );

    expect(second.timestamp).toBeGreaterThan(
      cursor,
    );
  });

  it('returns a new mission created after the initial pull', async () => {
    const initial =
      await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: null,
        limit: 500,
      });

    const cursor =
      initial.timestamp;

    const newMissionId =
      crypto.randomUUID();

    await pool.query(
      "INSERT INTO missions (id, agent_id, title) VALUES ($1, $2, $3)",
      [
        newMissionId,
        agentA,
        'Mission créée après Pull',
      ],
    );

    const second =
      await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: cursor,
        limit: 500,
      });

    const created =
      second.changes.missions.created.find(
        (mission) =>
          mission.id === newMissionId,
      );

    expect(created).toBeDefined();

    expect(created?.title).toBe(
      'Mission créée après Pull',
    );
  });

  it('returns a soft-deleted mission in deleted', async () => {
    const initial =
      await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: null,
        limit: 500,
      });

    const cursor =
      initial.timestamp;

    await pool.query(
      "UPDATE missions SET deleted_at = $1 WHERE id = $2",
      [Date.now(), missionA],
    );

    const second =
      await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: cursor,
        limit: 500,
      });

    expect(
      second.changes.missions.deleted,
    ).toContain(missionA);

    expect(
      second.changes.missions.updated,
    ).not.toContainEqual(
      expect.objectContaining({
        id: missionA,
      }),
    );
  });

  it('paginates a mixed global sync stream without skipping events', async () => {
    const initial =
      await pull.pullChanges({
        agentId: agentA,
        lastPulledAt: null,
        limit: 500,
      });

    let cursor =
      initial.timestamp;

    const createdMissionIds: string[] = [];

    for (let i = 0; i < 7; i++) {
      const id =
        crypto.randomUUID();

      createdMissionIds.push(id);

      await pool.query(
        "INSERT INTO missions (id, agent_id, title) VALUES ($1, $2, $3)",
        [
          id,
          agentA,
          `Pagination Mission ${i}`,
        ],
      );
    }

    const receivedIds: string[] = [];

    let hasMore = true;

    let guard = 0;

    while (hasMore) {
      guard++;

      if (guard > 20) {
        throw new Error(
          'Pagination loop exceeded 20 iterations.',
        );
      }

      const page =
        await pull.pullChanges({
          agentId: agentA,
          lastPulledAt: cursor,
          limit: 2,
        });

      for (const mission of [
        ...page.changes.missions.created,
        ...page.changes.missions.updated,
      ]) {
        if (
          createdMissionIds.includes(
            mission.id,
          )
        ) {
          receivedIds.push(
            mission.id,
          );
        }
      }

      expect(page.timestamp).toBeGreaterThanOrEqual(
        cursor,
      );

      if (
        page.timestamp === cursor &&
        page.has_more
      ) {
        throw new Error(
          'Cursor did not advance while has_more=true.',
        );
      }

      cursor =
        page.timestamp;

      hasMore =
        page.has_more;
    }

    expect(
      new Set(receivedIds).size,
    ).toBe(
      createdMissionIds.length,
    );

    expect(
      receivedIds.length,
    ).toBe(
      createdMissionIds.length,
    );
  });
  it('applies an update when client version matches server version', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    const vr = await pool.query('SELECT sync_seq FROM check_ins WHERE id = $1', [id]);
    const version = Number(vr.rows[0].sync_seq);
    const response = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version, check_out_time: Date.now() }] } } });
    expect(response.applied.updated).toBe(1);
    expect(response.conflicts).toHaveLength(0);
  });

  it('records a conflict when client version is stale', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const response = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });
    expect(response.applied.updated).toBe(0);
    expect(response.conflicts).toHaveLength(1);
    expect(response.conflicts[0].entity_id).toBe(id);
  });

  it('applies valid updates and records conflicts in the same batch', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await push.pushChanges(agentA, { changes: { check_ins: { created: ids.map((id) => ({ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' })) } } });
    const versions = await pool.query('SELECT id, sync_seq FROM check_ins WHERE id = ANY($1::uuid[])', [ids]);
    const vmap = new Map(versions.rows.map((r) => [r.id, Number(r.sync_seq)]));
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [ids[1]]);
    const response = await push.pushChanges(agentA, { changes: { check_ins: { updated: [
      { id: ids[0], version: vmap.get(ids[0])!, check_out_time: Date.now() },
      { id: ids[1], version: vmap.get(ids[1])!, check_out_time: Date.now() },
      { id: ids[2], version: vmap.get(ids[2])!, check_out_time: Date.now() },
    ] } } });
    expect(response.applied.updated).toBe(2);
    expect(response.conflicts).toHaveLength(1);
    expect(response.conflicts[0].entity_id).toBe(ids[1]);
  });

  it('rolls back the whole batch on a technical error', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    const vr = await pool.query('SELECT sync_seq FROM check_ins WHERE id = $1', [id]);
    const version = Number(vr.rows[0].sync_seq);
    const ghost = randomUUID();
    await expect(push.pushChanges(agentA, { changes: { check_ins: { updated: [
      { id, version, check_out_time: Date.now() },
      { id: ghost, version: 1, check_out_time: Date.now() },
    ] } } })).rejects.toBeInstanceOf(ForbiddenException);
    const check = await pool.query('SELECT check_out_time FROM check_ins WHERE id = $1', [id]);
    expect(check.rows[0].check_out_time).toBeNull();
  });

  it('does not duplicate conflict on idempotent replay', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const dto = { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } };
    const r1 = await push.pushChanges(agentA, dto, 'conflict-key');
    const r2 = await push.pushChanges(agentA, dto, 'conflict-key');
    expect(r1.conflicts).toHaveLength(1);
    expect(r2.conflicts).toHaveLength(0);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM sync_conflicts WHERE entity_id = $1', [id]);
    expect(count.rows[0].n).toBe(1);
  });

  it('detects conflict between two concurrent clients', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    const vr = await pool.query('SELECT sync_seq FROM check_ins WHERE id = $1', [id]);
    const v = Number(vr.rows[0].sync_seq);
    const rA = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: v, check_out_time: Date.now() }] } } });
    expect(rA.applied.updated).toBe(1);
    const rB = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: v, check_out_time: Date.now() + 1000 }] } } });
    expect(rB.applied.updated).toBe(0);
    expect(rB.conflicts).toHaveLength(1);
  });

  it("rejects an update that moves a check-in to another agent's mission", async () => {
    const checkInId = randomUUID();
    const missionB = randomUUID();
    const agentB = randomUUID();

    // Mission appartenant à un autre agent.
    await pool.query(
      `
        INSERT INTO missions (
          id,
          agent_id,
          title,
          site_id
        )
        VALUES ($1, $2, $3, $4)
      `,
      [
        missionB,
        agentB,
        'Mission B',
        siteA,
      ],
    );

    // Check-in appartenant à agentA sur missionA.
    await pool.query(
      `
        INSERT INTO check_ins (
          id,
          mission_id,
          agent_id,
          check_in_time,
          check_out_time,
          check_in_lat,
          check_in_lng,
          check_in_method,
          created_at,
          updated_at,
          deleted_at,
          sync_seq
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NULL,
          $5,
          $6,
          $7,
          $8,
          $8,
          NULL,
          0
        )
      `,
      [
        checkInId,
        missionA,
        agentA,
        1650000000000,
        48.85,
        2.35,
        'GPS',
        Date.now(),
      ],
    );

    const before = await pool.query(
      `
        SELECT
          mission_id,
          check_out_time,
          sync_seq
        FROM check_ins
        WHERE id = $1
      `,
      [checkInId],
    );

    expect(before.rows).toHaveLength(1);

    const currentVersion = Number(before.rows[0].sync_seq);
    const originalMissionId = before.rows[0].mission_id;
    const originalSyncSeq = currentVersion;

    await expect(
      push.pushChanges(agentA, {
        changes: {
          check_ins: {
            updated: [
              {
                id: checkInId,
                version: currentVersion,
                mission_id: missionB,
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(/mission .* non autorisee/);

    // Vérifie que le check-in n'a pas été modifié.
    const after = await pool.query(
      `
        SELECT
          mission_id,
          check_out_time,
          sync_seq
        FROM check_ins
        WHERE id = $1
      `,
      [checkInId],
    );

    expect(after.rows).toHaveLength(1);

    expect(after.rows[0].mission_id).toBe(originalMissionId);
    expect(after.rows[0].check_out_time).toBeNull();

    // Le sync_seq ne doit pas avoir changé :
    // l'opération interdite doit avoir été entièrement rollbackée.
    expect(Number(after.rows[0].sync_seq)).toBe(originalSyncSeq);
  });

  it('lists no conflicts when there are none', async () => {
    const result = await conflict.listConflicts({ agentId: agentA });
    expect(result).toHaveLength(0);
  });

  it('lists pending conflicts for the agent', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });

    const result = await conflict.listConflicts({ agentId: agentA, status: 'pending' });
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe(id);
    expect(result[0].status).toBe('pending');
  });

  it('does not leak conflicts to another agent', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });

    const leaked = await conflict.listConflicts({ agentId: agentB });
    expect(leaked).toHaveLength(0);
  });

  it('applies client payload when resolving as client', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const r = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: 9999 }] } } });
    const conflictId = r.conflicts[0].conflict_id;

    await conflict.resolveConflict({ conflictId, agentId: agentA, resolution: 'client', resolvedBy: agentA });

    const after = await pool.query('SELECT check_out_time FROM check_ins WHERE id = $1', [id]);
    expect(Number(after.rows[0].check_out_time)).toBe(9999);

    const c = await pool.query('SELECT status, resolution FROM sync_conflicts WHERE id = $1', [conflictId]);
    expect(c.rows[0].status).toBe('resolved');
    expect(c.rows[0].resolution).toBe('client');
  });

  it('leaves data untouched when resolving as server', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const r = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: 9999 }] } } });
    const conflictId = r.conflicts[0].conflict_id;

    await conflict.resolveConflict({ conflictId, agentId: agentA, resolution: 'server', resolvedBy: agentA });

    const after = await pool.query('SELECT check_out_time FROM check_ins WHERE id = $1', [id]);
    expect(after.rows[0].check_out_time).toBeNull();

    const c = await pool.query('SELECT status, resolution FROM sync_conflicts WHERE id = $1', [conflictId]);
    expect(c.rows[0].resolution).toBe('server');
  });

  it('marks resolved without applying on dismiss', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const r = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: 9999 }] } } });
    const conflictId = r.conflicts[0].conflict_id;

    await conflict.resolveConflict({ conflictId, agentId: agentA, resolution: 'dismiss', resolvedBy: agentA });

    const after = await pool.query('SELECT check_out_time FROM check_ins WHERE id = $1', [id]);
    expect(after.rows[0].check_out_time).toBeNull();

    const c = await pool.query('SELECT status, resolution FROM sync_conflicts WHERE id = $1', [conflictId]);
    expect(c.rows[0].status).toBe('resolved');
    expect(c.rows[0].resolution).toBe('dismiss');
  });

  it('rejects resolving an already resolved conflict', async () => {
    const id = randomUUID();
    await push.pushChanges(agentA, { changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });
    await pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const r = await push.pushChanges(agentA, { changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });
    const conflictId = r.conflicts[0].conflict_id;

    await conflict.resolveConflict({ conflictId, agentId: agentA, resolution: 'server', resolvedBy: agentA });

    await expect(
      conflict.resolveConflict({ conflictId, agentId: agentA, resolution: 'client', resolvedBy: agentA }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});