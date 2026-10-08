import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { withTenant } from './with-tenant.js';
import type { AttachmentStorage } from './attachment-storage.js';

export interface PurgeResult {
  idempotencyDeleted: number;
  conflictsDeleted: number;
}

export interface PurgeOptions {
  ttlIdempotencyDays?: number;
  ttlConflictsDays?: number;
}

export interface PurgeSyncLogsResult {
  logsDeleted: number;
}

export interface PurgeTombstonesResult {
  checkInsDeleted: number;
  missionsDeleted: number;
  sitesDeleted: number;
  purgedUpToSeq: number;
  /** Object keys of attachments cascaded away by the check_ins DELETE. */
  orphanedObjectKeys: string[];
}

export interface PurgeTenantStorageResult {
  deleted: number;
  failed: number;
}

export class SyncMaintenanceService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(db: NodePgDatabase<typeof schema>) {
    this.db = db;
  }

  async purge(options: PurgeOptions = {}): Promise<PurgeResult> {
    const ttlIdempotencyDays = options.ttlIdempotencyDays ?? 7;
    const ttlConflictsDays = options.ttlConflictsDays ?? 30;

    if (ttlIdempotencyDays < 0 || ttlConflictsDays < 0) {
      throw new Error('TTL ne peut pas etre negatif.');
    }

    const result = await this.db.execute(sql`
      SELECT purge_sync_tables(
        ${ttlIdempotencyDays}::int,
        ${ttlConflictsDays}::int
      ) AS result
    `);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    const payload = row?.result as Record<string, unknown> | undefined;

    if (!payload) {
      throw new Error('purge_sync_tables a retourne un resultat vide.');
    }

    return {
      idempotencyDeleted: Number(payload.idempotency_deleted ?? 0),
      conflictsDeleted: Number(payload.conflicts_deleted ?? 0),
    };
  }

  async purgeTenantTombstones(
    tenantId: string,
    ttlDays: number = 30,
  ): Promise<PurgeTombstonesResult> {
    if (!tenantId) throw new Error('tenantId requis.');
    if (ttlDays < 0) throw new Error('ttlDays doit etre >= 0.');

    return withTenant(this.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT purge_tenant_tombstones(${tenantId}::uuid, ${ttlDays}::int) AS result
    `);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    const payload = row?.result as Record<string, unknown> | undefined;

    if (!payload) {
      throw new Error('purge_tenant_tombstones a retourne un resultat vide.');
    }

    return {
      checkInsDeleted: Number(payload.check_ins_deleted ?? 0),
      missionsDeleted: Number(payload.missions_deleted ?? 0),
      sitesDeleted: Number(payload.sites_deleted ?? 0),
      purgedUpToSeq: Number(payload.purged_up_to_seq ?? 0),
      orphanedObjectKeys: Array.isArray(payload.orphaned_object_keys)
        ? (payload.orphaned_object_keys as string[])
        : [],
    };
    });
  }

  /**
   * Purges sync_logs older than ttlDays (default 30) for one tenant.
   *
   * Runs through a SECURITY DEFINER function because sync_app has no
   * DELETE privilege on sync_logs (append-only since migration 014).
   * See migrations/015_purge_sync_logs.sql.
   */
  async purgeSyncLogs(
    tenantId: string,
    ttlDays: number = 30,
  ): Promise<PurgeSyncLogsResult> {
    if (!tenantId) throw new Error('tenantId requis.');
    if (ttlDays < 0) throw new Error('ttlDays doit etre >= 0.');

    return withTenant(this.db, tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT purge_tenant_sync_logs(${tenantId}::uuid, ${ttlDays}::int) AS result
      `);

      const row = result.rows[0] as Record<string, unknown> | undefined;
      const payload = row?.result as Record<string, unknown> | undefined;

      if (!payload) {
        throw new Error('purge_tenant_sync_logs a retourne un resultat vide.');
      }

      return { logsDeleted: Number(payload.logs_deleted ?? 0) };
    });
  }

  /**
   * Deletes the given object keys from the attachment storage, one by
   * one. Never throws: a failed DELETE is counted and logged, the
   * remaining keys are attempted, and the caller decides what to do
   * (typically: nothing, the next scan will pick up the orphans).
   *
   * Pairs with purgeTenantTombstones: the tombstone purge returns the
   * object keys cascaded away with the check-ins, and this method turns
   * that list into actual S3 DELETEs.
   */
  async purgeTenantStorage(
    storage: AttachmentStorage,
    objectKeys: string[],
  ): Promise<PurgeTenantStorageResult> {
    let deleted = 0;
    let failed = 0;
    for (const key of objectKeys) {
      try {
        await storage.delete(key);
        deleted += 1;
      } catch (err) {
        failed += 1;
        console.error('[maintenance] storage delete failed for ' + key + ':', err);
      }
    }
    return { deleted, failed };
  }
}