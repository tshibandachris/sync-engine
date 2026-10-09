import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';
import type { AttachmentStorage } from './attachment-storage.js';
import { SyncMaintenanceService } from './sync-maintenance.service.js';

/**
 * Advisory lock key for the maintenance run. Distinct from
 *   - TENANT_WRITE_LOCK_NS (7301, 2-arg variant)
 *   - attachment and idempotency locks
 * The 1-arg int8 variant uses a namespace disjoint from the 2-arg
 * (int4, int4) variant, so 7302 cannot collide with any tenant lock.
 */
const MAINTENANCE_LOCK_KEY = 7302;

/**
 * The subset of SyncMaintenanceService that the orchestrator uses.
 * Extracted so a test can pass a hand-rolled service that fails one
 * tenant on purpose.
 */
export interface MaintenanceServiceLike {
  purgeSyncLogs(tenantId: string, ttlDays: number): Promise<{ logsDeleted: number }>;
  purgeTenantPendingAttachments(tenantId: string, ttlDays: number): Promise<{ deleted: number }>;
  purgeTenantTombstones(tenantId: string, ttlDays: number): Promise<{
    checkInsDeleted: number;
    missionsDeleted: number;
    sitesDeleted: number;
    purgedUpToSeq: number;
    orphanedObjectKeys: string[];
  }>;
  purgeTenantStorage(storage: AttachmentStorage, keys: string[]): Promise<{ deleted: number; failed: number }>;
  scanTenantOrphans(
    storage: AttachmentStorage,
    tenantId: string,
    options?: { dryRun?: boolean; allowHighOrphanRatio?: boolean },
  ): Promise<{
    tenantId: string;
    scanned: number;
    orphans: string[];
    deleted: number;
    failed: number;
    dryRun: boolean;
    aborted: boolean;
    abortReason?: string;
  }>;
}

export interface MaintenanceOptions {
  syncLogsTtlDays?: number;
  pendingAttachmentsTtlDays?: number;
  tombstonesTtlDays?: number;
  /** When set, only these tenants are processed. Empty array means none. */
  tenantFilter?: string[];
}

export interface MaintenanceTenantReport {
  tenantId: string;
  syncLogsDeleted: number;
  pendingAttachmentsDeleted: number;
  checkInsDeleted: number;
  missionsDeleted: number;
  sitesDeleted: number;
  orphanedKeysDeleted: number;
  orphanedKeysFailed: number;
  orphansFound: number;
  error?: string;
}

export interface MaintenanceReport {
  startedAt: number;
  finishedAt: number;
  tenantsProcessed: number;
  tenantsSucceeded: number;
  tenantsFailed: number;
  /** True when another runner already held the lock; this one did nothing. */
  skipped: boolean;
  perTenant: MaintenanceTenantReport[];
}

export interface MaintenanceDeps {
  /** The pool used only for the advisory lock on a dedicated connection. */
  pool: Pool;
  /** The database used for everything else. */
  db: NodePgDatabase<typeof schema>;
  storage: AttachmentStorage;
  /** Override the service, for tests. */
  service?: MaintenanceServiceLike;
}

/**
 * Runs every per-tenant maintenance purge once.
 *
 * Holds a session-level advisory lock on a dedicated connection for the
 * duration of the run. A second call while the lock is held returns
 * immediately with skipped: true. The lock is purely a coordination
 * signal: the actual work runs on the pool, so holding it does not
 * serialize anything else.
 *
 * Per-tenant errors are isolated: one failing tenant does not stop the
 * others, and its error is recorded in the report. The caller decides
 * what exit code to use.
 */
export async function runMaintenanceCycle(
  deps: MaintenanceDeps,
  options: MaintenanceOptions = {},
): Promise<MaintenanceReport> {
  const syncLogsTtlDays = options.syncLogsTtlDays ?? 30;
  const pendingAttachmentsTtlDays = options.pendingAttachmentsTtlDays ?? 7;
  const tombstonesTtlDays = options.tombstonesTtlDays ?? 30;

  const startedAt = Date.now();
  const svc = deps.service ?? new SyncMaintenanceService(deps.db);

  const lockClient = await deps.pool.connect();
  try {
    const lockRes = await lockClient.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS ok',
      [MAINTENANCE_LOCK_KEY],
    );
    if (!lockRes.rows[0]?.ok) {
      return {
        startedAt,
        finishedAt: Date.now(),
        tenantsProcessed: 0,
        tenantsSucceeded: 0,
        tenantsFailed: 0,
        skipped: true,
        perTenant: [],
      };
    }

    try {
      const tenantRows = await deps.db.execute(sql`SELECT id FROM tenants ORDER BY id`);
      let tenantIds = tenantRows.rows.map((r) => String((r as Record<string, unknown>).id));
      if (options.tenantFilter) {
        const set = new Set(options.tenantFilter);
        tenantIds = tenantIds.filter((t) => set.has(t));
      }

      const perTenant: MaintenanceTenantReport[] = [];
      let succeeded = 0;
      let failed = 0;

      for (const tenantId of tenantIds) {
        try {
          const syncLogs = await svc.purgeSyncLogs(tenantId, syncLogsTtlDays);
          const pending = await svc.purgeTenantPendingAttachments(tenantId, pendingAttachmentsTtlDays);
          const tombstones = await svc.purgeTenantTombstones(tenantId, tombstonesTtlDays);
          const storagePurge = await svc.purgeTenantStorage(deps.storage, tombstones.orphanedObjectKeys);
          // Always dry-run from the cron: real orphan deletion is an
          // operator decision, reviewed against the dry-run report.
          const scan = await svc.scanTenantOrphans(deps.storage, tenantId, { dryRun: true });

          perTenant.push({
            tenantId,
            syncLogsDeleted: syncLogs.logsDeleted,
            pendingAttachmentsDeleted: pending.deleted,
            checkInsDeleted: tombstones.checkInsDeleted,
            missionsDeleted: tombstones.missionsDeleted,
            sitesDeleted: tombstones.sitesDeleted,
            orphanedKeysDeleted: storagePurge.deleted,
            orphanedKeysFailed: storagePurge.failed,
            orphansFound: scan.orphans.length,
          });
          succeeded += 1;
        } catch (err) {
          failed += 1;
          perTenant.push({
            tenantId,
            syncLogsDeleted: 0,
            pendingAttachmentsDeleted: 0,
            checkInsDeleted: 0,
            missionsDeleted: 0,
            sitesDeleted: 0,
            orphanedKeysDeleted: 0,
            orphanedKeysFailed: 0,
            orphansFound: 0,
            error: (err as Error).message,
          });
        }
      }

      return {
        startedAt,
        finishedAt: Date.now(),
        tenantsProcessed: tenantIds.length,
        tenantsSucceeded: succeeded,
        tenantsFailed: failed,
        skipped: false,
        perTenant,
      };
    } finally {
      await lockClient
        .query('SELECT pg_advisory_unlock($1::bigint)', [MAINTENANCE_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    lockClient.release();
  }
}
