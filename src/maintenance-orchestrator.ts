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
  /** Failed steps, as "step: message", joined by "; ". Absent when every step succeeded. */
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

interface Ttls {
  syncLogsTtlDays: number;
  pendingAttachmentsTtlDays: number;
  tombstonesTtlDays: number;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Runs the five purge steps of one tenant. Each step is isolated: a failure is
 * recorded as "step: message" and the next steps still run, so one broken step
 * neither erases the counters already collected nor starves the later steps.
 * The storage purge depends on the keys returned by the tombstone purge, so it
 * only runs when that step succeeded.
 */
async function processTenant(
  svc: MaintenanceServiceLike,
  storage: AttachmentStorage,
  tenantId: string,
  ttls: Ttls,
): Promise<MaintenanceTenantReport> {
  const row: MaintenanceTenantReport = {
    tenantId,
    syncLogsDeleted: 0,
    pendingAttachmentsDeleted: 0,
    checkInsDeleted: 0,
    missionsDeleted: 0,
    sitesDeleted: 0,
    orphanedKeysDeleted: 0,
    orphanedKeysFailed: 0,
    orphansFound: 0,
  };
  const failures: string[] = [];

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      failures.push(name + ': ' + errorMessage(err));
      return undefined;
    }
  };

  const syncLogs = await step('syncLogs', () => svc.purgeSyncLogs(tenantId, ttls.syncLogsTtlDays));
  if (syncLogs) row.syncLogsDeleted = syncLogs.logsDeleted;

  const pending = await step('pendingAttachments', () =>
    svc.purgeTenantPendingAttachments(tenantId, ttls.pendingAttachmentsTtlDays),
  );
  if (pending) row.pendingAttachmentsDeleted = pending.deleted;

  const tombstones = await step('tombstones', () => svc.purgeTenantTombstones(tenantId, ttls.tombstonesTtlDays));
   if (tombstones) {
    row.checkInsDeleted = tombstones.checkInsDeleted;
    row.missionsDeleted = tombstones.missionsDeleted;
    row.sitesDeleted = tombstones.sitesDeleted;
    const storagePurge = await step('storage', () => svc.purgeTenantStorage(storage, tombstones.orphanedObjectKeys));
    if (storagePurge) {
      row.orphanedKeysDeleted = storagePurge.deleted;
      row.orphanedKeysFailed = storagePurge.failed;
      if (storagePurge.failed > 0) {
        failures.push('storage: ' + storagePurge.failed + ' key(s) not deleted');
      }
    }
  }

  // Always dry-run from the cron: real orphan deletion is an
  // operator decision, reviewed against the dry-run report.
   const scan = await step('orphanScan', () => svc.scanTenantOrphans(storage, tenantId, { dryRun: true }));
  if (scan) {
    row.orphansFound = scan.orphans.length;
    if (scan.aborted) {
      failures.push(
        'orphanScan: aborted (' + (scan.abortReason ?? 'no reason given') + ')',
      );
    }
  }
  if (failures.length > 0) row.error = failures.join('; ');
  return row;
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
 * Errors are isolated per step and per tenant: one failing step or tenant
 * does not stop the others, and is recorded in the report. The caller
 * decides what exit code to use.
 *
 * If the unlock fails, the lock connection is destroyed instead of being
 * returned to the pool: closing the session frees the session-level lock.
 */
export async function runMaintenanceCycle(
  deps: MaintenanceDeps,
  options: MaintenanceOptions = {},
): Promise<MaintenanceReport> {
  const ttls: Ttls = {
    syncLogsTtlDays: options.syncLogsTtlDays ?? 30,
    pendingAttachmentsTtlDays: options.pendingAttachmentsTtlDays ?? 7,
    tombstonesTtlDays: options.tombstonesTtlDays ?? 30,
  };

  const startedAt = Date.now();
  const svc = deps.service ?? new SyncMaintenanceService(deps.db);

  let locked = false;
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
    locked = true;

    const tenantRows = await deps.db.execute(sql`SELECT id FROM tenants ORDER BY id`);
    let tenantIds = tenantRows.rows.map((r) => String((r as Record<string, unknown>).id));
    if (options.tenantFilter) {
      const set = new Set(options.tenantFilter);
      tenantIds = tenantIds.filter((t) => set.has(t));
    }

    const perTenant: MaintenanceTenantReport[] = [];
    for (const tenantId of tenantIds) {
      perTenant.push(await processTenant(svc, deps.storage, tenantId, ttls));
    }

    const failed = perTenant.filter((r) => r.error !== undefined).length;
    return {
      startedAt,
      finishedAt: Date.now(),
      tenantsProcessed: tenantIds.length,
      tenantsSucceeded: tenantIds.length - failed,
      tenantsFailed: failed,
      skipped: false,
      perTenant,
    };
  } finally {
    let unlocked = !locked;
    if (locked) {
      unlocked = await lockClient
        .query<{ ok: boolean }>('SELECT pg_advisory_unlock($1::bigint) AS ok', [MAINTENANCE_LOCK_KEY])
        .then((r) => r.rows[0]?.ok === true)
        .catch(() => false);
    }
    // release(true) destroys the connection, which frees the session-level lock.
    lockClient.release(!unlocked);
  }
}
