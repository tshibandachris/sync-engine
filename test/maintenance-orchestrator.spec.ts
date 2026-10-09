import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import {
  runMaintenanceCycle,
  type MaintenanceServiceLike,
} from '../src/maintenance-orchestrator.js';
import type {
  AttachmentStorage,
  PresignedPut,
  PresignedGet,
  HeadResult,
} from '../src/attachment-storage.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_KEY = 7302;

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

class MemStorage implements AttachmentStorage {
  readonly objects = new Map<string, number>();
  readonly deletes: string[] = [];
  async presignPut(): Promise<PresignedPut> { return { url: 'x', expiresIn: 0 }; }
  async presignGet(): Promise<PresignedGet> { return { url: 'x', expiresIn: 0 }; }
  async head(): Promise<HeadResult> { return { exists: false }; }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }
  async listByPrefix(prefix: string): Promise<{ key: string; sizeBytes: number }[]> {
    return Array.from(this.objects.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, sizeBytes]) => ({ key, sizeBytes }));
  }
}

/**
 * Full SyncMaintenanceService, with the ability to fail one tenant.
 * The other methods fall through to a real service on the same db.
 */
function makeService(db: any, failTenantId?: string): MaintenanceServiceLike {
  const real = new SyncMaintenanceService(db);
  return {
    purgeSyncLogs(tenantId, ttlDays) {
      if (tenantId === failTenantId) throw new Error('simulated failure');
      return real.purgeSyncLogs(tenantId, ttlDays);
    },
    purgeTenantPendingAttachments: (t, d) => real.purgeTenantPendingAttachments(t, d),
    purgeTenantTombstones: (t, d) => real.purgeTenantTombstones(t, d),
    purgeTenantStorage: (s, k) => real.purgeTenantStorage(s, k),
    scanTenantOrphans: (s, t, o) => real.scanTenantOrphans(s, t, o),
  };
}

describe('runMaintenanceCycle', () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  async function registerTenant(id: string): Promise<void> {
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [id, Date.now()],
    );
  }

  async function clearTenants(): Promise<void> {
    await pg.pool.query('DELETE FROM tenants');
  }

  it('retourne un rapport vide quand aucun tenant n\'est enregistre', async () => {
    await clearTenants();
    const report = await runMaintenanceCycle({
      pool: pg.pool as Pool,
      db: pg.appDb,
      storage,
    });
    expect(report.skipped).toBe(false);
    expect(report.tenantsProcessed).toBe(0);
    expect(report.tenantsSucceeded).toBe(0);
    expect(report.tenantsFailed).toBe(0);
    expect(report.perTenant).toEqual([]);
  });

  it('traite un tenant et retourne les compteurs', async () => {
    await clearTenants();
    const tenantId = randomUUID();
    await registerTenant(tenantId);

    // Un log sync vieux de 40 jours doit etre purge par la ttl par defaut
    await pg.pool.query(
      `INSERT INTO sync_logs
         (id, request_id, tenant_id, operation, status_code, started_at, duration_ms,
          records_in, records_out, conflicts, errors)
       VALUES ($1, $2, $3, 'pull', 201, $4, 10, 0, 0, 0, 0)`,
      [randomUUID(), randomUUID(), tenantId, Date.now() - 40 * DAY_MS],
    );

    const report = await runMaintenanceCycle({
      pool: pg.pool as Pool,
      db: pg.appDb,
      storage,
    });
    expect(report.skipped).toBe(false);
    expect(report.tenantsProcessed).toBe(1);
    expect(report.tenantsSucceeded).toBe(1);
    expect(report.tenantsFailed).toBe(0);
    expect(report.perTenant).toHaveLength(1);
    expect(report.perTenant[0].tenantId).toBe(tenantId);
    expect(report.perTenant[0].syncLogsDeleted).toBe(1);
    expect(report.perTenant[0].error).toBeUndefined();
  });

  it('isole les erreurs : un tenant qui echoue n\'arrete pas les autres', async () => {
    await clearTenants();
    const goodTenant = randomUUID();
    const badTenant = randomUUID();
    await registerTenant(goodTenant);
    await registerTenant(badTenant);

    // L'ordre de SELECT id FROM tenants ORDER BY id n'est pas garanti,
    // on teste juste que les deux sont traites.
    const svc = makeService(pg.appDb, badTenant);

    const report = await runMaintenanceCycle(
      { pool: pg.pool as Pool, db: pg.appDb, storage, service: svc },
    );
    expect(report.tenantsProcessed).toBe(2);
    expect(report.tenantsSucceeded).toBe(1);
    expect(report.tenantsFailed).toBe(1);

    const bad = report.perTenant.find((r) => r.tenantId === badTenant);
    const good = report.perTenant.find((r) => r.tenantId === goodTenant);
    expect(bad?.error).toMatch(/simulated failure/);
    expect(good?.error).toBeUndefined();
  });

  it('saute si un autre runner tient le lock', async () => {
    await clearTenants();
    await registerTenant(randomUUID());

    const otherClient = await pg.appPool.connect();
    try {
      await otherClient.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);

      const report = await runMaintenanceCycle({
        pool: pg.pool as Pool,
        db: pg.appDb,
        storage,
      });
      expect(report.skipped).toBe(true);
      expect(report.tenantsProcessed).toBe(0);
      expect(report.perTenant).toEqual([]);
    } finally {
      await otherClient.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
      otherClient.release();
    }
  });

  it('respecte tenantFilter : seuls les tenants demandes sont traites', async () => {
    await clearTenants();
    const t1 = randomUUID();
    const t2 = randomUUID();
    await registerTenant(t1);
    await registerTenant(t2);

    const report = await runMaintenanceCycle(
      { pool: pg.pool as Pool, db: pg.appDb, storage },
      { tenantFilter: [t1] },
    );
    expect(report.tenantsProcessed).toBe(1);
    expect(report.perTenant).toHaveLength(1);
    expect(report.perTenant[0].tenantId).toBe(t1);
  });

  it('le scan orphelins tourne toujours en dry-run depuis le runner', async () => {
    await clearTenants();
    const tenantId = randomUUID();
    await registerTenant(tenantId);

    // Un objet S3 sans ligne attachments = orphelin detectable
    storage.objects.set('tenants/' + tenantId + '/checkins/x/y.jpg', 1024);

    const report = await runMaintenanceCycle({
      pool: pg.pool as Pool,
      db: pg.appDb,
      storage,
    });
    expect(report.perTenant[0].orphansFound).toBe(1);
    // Aucune suppression reelle : le dry-run n'a pas d'effet sur S3
    expect(storage.objects.has('tenants/' + tenantId + '/checkins/x/y.jpg')).toBe(true);
  });
});
