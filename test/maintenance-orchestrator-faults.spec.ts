import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import {
  runMaintenanceCycle,
  type MaintenanceServiceLike,
} from '../src/maintenance-orchestrator.js';
import type { AttachmentStorage } from '../src/attachment-storage.js';

const LOCK_KEY = 7302;

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

// Le service simulé ignore le stockage : un objet vide suffit.
const storage = {} as AttachmentStorage;

// Service simulé : chaque étape note son passage et renvoie des compteurs reconnaissables.
function fakeService(calls: string[], over: Partial<MaintenanceServiceLike> = {}): MaintenanceServiceLike {
  return {
    purgeSyncLogs: async () => {
      calls.push('syncLogs');
      return { logsDeleted: 2 };
    },
    purgeTenantPendingAttachments: async () => {
      calls.push('pending');
      return { deleted: 3 };
    },
    purgeTenantTombstones: async () => {
      calls.push('tombstones');
      return {
        checkInsDeleted: 4,
        missionsDeleted: 5,
        sitesDeleted: 6,
        purgedUpToSeq: 7,
        orphanedObjectKeys: ['k1', 'k2'],
      };
    },
    purgeTenantStorage: async () => {
      calls.push('storage');
      return { deleted: 2, failed: 0 };
    },
    scanTenantOrphans: async () => {
      calls.push('scan');
      return { tenantId: '', scanned: 1, orphans: ['o1'], deleted: 0, failed: 0, dryRun: true, aborted: false };
    },
    ...over,
  };
}

describe('runMaintenanceCycle : pannes partielles et verrou', () => {
  let tenantId: string;

  beforeEach(async () => {
    await pg.pool.query('DELETE FROM tenants');
    tenantId = randomUUID();
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)', [tenantId, Date.now()]);
  });

  const run = (service: MaintenanceServiceLike) =>
    runMaintenanceCycle({ pool: pg.pool as Pool, db: pg.appDb, storage, service });

  it('une étape en échec ne bloque pas les suivantes et ne perd pas les compteurs acquis', async () => {
    const calls: string[] = [];
    const report = await run(
      fakeService(calls, {
        purgeSyncLogs: async () => {
          throw new Error('db down');
        },
      }),
    );

    expect(calls).toEqual(['pending', 'tombstones', 'storage', 'scan']);
    expect(report.tenantsFailed).toBe(1);
    expect(report.tenantsSucceeded).toBe(0);
    const row = report.perTenant[0];
    expect(row.error).toBe('syncLogs: db down');
    expect(row.syncLogsDeleted).toBe(0);
    expect(row.pendingAttachmentsDeleted).toBe(3);
    expect(row.checkInsDeleted).toBe(4);
    expect(row.missionsDeleted).toBe(5);
    expect(row.sitesDeleted).toBe(6);
    expect(row.orphanedKeysDeleted).toBe(2);
    expect(row.orphansFound).toBe(1);
  });

  it('si les tombstones échouent, la purge du stockage est sautée mais le scan tourne', async () => {
    const calls: string[] = [];
    const report = await run(
      fakeService(calls, {
        purgeTenantTombstones: async () => {
          throw new Error('tombstones down');
        },
      }),
    );

    expect(calls).toEqual(['syncLogs', 'pending', 'scan']);
    const row = report.perTenant[0];
    expect(row.error).toBe('tombstones: tombstones down');
    expect(row.syncLogsDeleted).toBe(2);
    expect(row.orphansFound).toBe(1);
  });

  it("une erreur qui n'est pas une Error apparaît dans le rapport", async () => {
    const report = await run(
      fakeService([], {
        purgeSyncLogs: async () => {
          throw 'texte brut';
        },
      }),
    );
    expect(report.perTenant[0].error).toBe('syncLogs: texte brut');
    expect(report.tenantsFailed).toBe(1);
  });

  it("plusieurs étapes en échec sont toutes rapportées, et le tenant n'est compté qu'une fois", async () => {
    const report = await run(
      fakeService([], {
        purgeTenantPendingAttachments: async () => {
          throw new Error('pending down');
        },
        scanTenantOrphans: async () => {
          throw new Error('scan down');
        },
      }),
    );
    const error = report.perTenant[0].error ?? '';
    expect(error).toContain('pendingAttachments: pending down');
    expect(error).toContain('orphanScan: scan down');
    expect(report.tenantsFailed).toBe(1);
    expect(report.tenantsProcessed).toBe(1);
  });

  it('le verrou est libéré après un cycle, même quand un tenant échoue', async () => {
    await run(
      fakeService([], {
        purgeSyncLogs: async () => {
          throw new Error('db down');
        },
      }),
    );

    // Une AUTRE session doit pouvoir prendre le verrou : sinon il est resté tenu.
    const probe = await pg.appPool.connect();
    try {
      const r = await probe.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
      expect(r.rows[0].ok).toBe(true);
      await probe.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
    } finally {
      probe.release();
    }
  });

  // Faux pool : une seule connexion, dont on contrôle le déverrouillage.
  function poolWithUnlock(unlockSucceeds: boolean) {
    const released: unknown[] = [];
    const client = {
      async query(text: string) {
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (text.includes('pg_advisory_unlock')) {
          if (!unlockSucceeds) throw new Error('connection lost');
          return { rows: [{ ok: true }] };
        }
        throw new Error('requête inattendue : ' + text);
      },
      release(arg?: unknown) {
        released.push(arg);
      },
    };
    return { pool: { connect: async () => client } as unknown as Pool, released };
  }

  it('si le déverrouillage échoue, la connexion du verrou est détruite (ce qui libère le verrou)', async () => {
    const { pool, released } = poolWithUnlock(false);
    const report = await runMaintenanceCycle({ pool, db: pg.appDb, storage }, { tenantFilter: [] });
    expect(report.tenantsProcessed).toBe(0);
    expect(released).toEqual([true]);
  });

  it('quand le déverrouillage réussit, la connexion est rendue normalement au pool', async () => {
    const { pool, released } = poolWithUnlock(true);
    await runMaintenanceCycle({ pool, db: pg.appDb, storage }, { tenantFilter: [] });
    expect(released).toEqual([false]);
  });
});
