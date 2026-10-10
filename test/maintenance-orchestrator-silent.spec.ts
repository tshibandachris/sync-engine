import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import {
  runMaintenanceCycle,
  type MaintenanceServiceLike,
} from '../src/maintenance-orchestrator.js';
import type { AttachmentStorage } from '../src/attachment-storage.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

// Le service simule ignore le stockage : un objet vide suffit.
const storage = {} as AttachmentStorage;

type ScanResult = Awaited<ReturnType<MaintenanceServiceLike['scanTenantOrphans']>>;
type StorageResult = Awaited<ReturnType<MaintenanceServiceLike['purgeTenantStorage']>>;

function service(
  scan: Partial<ScanResult> = {},
  storagePurge: Partial<StorageResult> = {},
): MaintenanceServiceLike {
  return {
    purgeSyncLogs: async () => ({ logsDeleted: 0 }),
    purgeTenantPendingAttachments: async () => ({ deleted: 0 }),
    purgeTenantTombstones: async () => ({
      checkInsDeleted: 1,
      missionsDeleted: 0,
      sitesDeleted: 0,
      purgedUpToSeq: 1,
      orphanedObjectKeys: ['k1', 'k2'],
    }),
    purgeTenantStorage: async () => ({ deleted: 2, failed: 0, ...storagePurge }),
    scanTenantOrphans: async (_s, tenantId) => ({
      tenantId,
      scanned: 10,
      orphans: [],
      deleted: 0,
      failed: 0,
      dryRun: true,
      aborted: false,
      ...scan,
    }),
  };
}

describe('runMaintenanceCycle : echecs silencieux', () => {
  beforeEach(async () => {
    await pg.pool.query('DELETE FROM tenants');
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)', [randomUUID(), Date.now()]);
  });

  const run = (svc: MaintenanceServiceLike) =>
    runMaintenanceCycle({ pool: pg.pool as Pool, db: pg.appDb, storage, service: svc });

  it('un scan interrompu par le garde-fou de ratio est un echec, pas un tenant propre', async () => {
    const report = await run(
      service({ aborted: true, abortReason: 'orphan ratio 80% above 50%', orphans: [] }),
    );
    expect(report.tenantsFailed).toBe(1);
    expect(report.tenantsSucceeded).toBe(0);
    const row = report.perTenant[0];
    expect(row.error).toContain('orphanScan: aborted');
    expect(row.error).toContain('orphan ratio 80% above 50%');
    expect(row.orphansFound).toBe(0);
  });

  it("des cles S3 non supprimees apres la purge des tombstones sont un echec, compteurs conserves", async () => {
    const report = await run(service({}, { deleted: 1, failed: 2 }));
    expect(report.tenantsFailed).toBe(1);
    const row = report.perTenant[0];
    expect(row.error).toContain('storage: 2 key(s) not deleted');
    expect(row.orphanedKeysDeleted).toBe(1);
    expect(row.orphanedKeysFailed).toBe(2);
    expect(row.checkInsDeleted).toBe(1);
  });

  it('un cycle propre reste un succes', async () => {
    const report = await run(service());
    expect(report.tenantsFailed).toBe(0);
    expect(report.tenantsSucceeded).toBe(1);
    expect(report.perTenant[0].error).toBeUndefined();
  });

  it('les deux echecs silencieux sont rapportes ensemble', async () => {
    const report = await run(service({ aborted: true, abortReason: 'boom' }, { failed: 1 }));
    const error = report.perTenant[0].error ?? '';
    expect(error).toContain('storage: 1 key(s) not deleted');
    expect(error).toContain('orphanScan: aborted');
    expect(report.tenantsFailed).toBe(1);
  });
});
