import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, lt, sql } from 'drizzle-orm';
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

export interface PurgePendingAttachmentsResult {
  deleted: number;
}

export interface ScanTenantOrphansOptions {
  /**
   * When true (the default), the scan only reports the orphans. Nothing
   * is deleted from storage. Real deletion requires dryRun: false.
   */
  dryRun?: boolean;
  /**
   * Safety valve. A real scan refuses to proceed if more than half of
   * the listed objects would be deleted: a suspiciously high orphan
   * ratio usually means the DB read returned zero rows for a reason
   * other than an empty table (RLS context lost, wrong tenant id). Set
   * this to true only after manually verifying a specific case.
   */
  allowHighOrphanRatio?: boolean;
}

export interface ScanTenantOrphansResult {
  tenantId: string;
  scanned: number;
  orphans: string[];
  deleted: number;
  failed: number;
  dryRun: boolean;
  aborted: boolean;
  abortReason?: string;
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

  /**
   * Lists every object under the tenant's S3 prefix, cross-checks
   * against the object_key values that attachments rows still reference,
   * and reports (or deletes) the difference.
   *
   * Per-tenant by design: reading the DB through withTenant means RLS
   * sees only this tenant's rows, and the S3 prefix scopes the listing
   * to this tenant's objects. A cross-tenant scan would have to bypass
   * RLS and risks deleting the wrong objects.
   *
   * dryRun defaults to true. Passing dryRun: false is a deliberate step
   * an operator takes after reviewing a dry-run output. A ratio guard
   * refuses to delete if more than 50% of the listed objects would go,
   * unless allowHighOrphanRatio is set.
   */
  async scanTenantOrphans(
    storage: AttachmentStorage,
    tenantId: string,
    options: ScanTenantOrphansOptions = {},
  ): Promise<ScanTenantOrphansResult> {
    if (!tenantId) throw new Error('tenantId requis.');
    const dryRun = options.dryRun ?? true;
    const allowHigh = options.allowHighOrphanRatio ?? false;

    const prefix = 'tenants/' + tenantId + '/';
    const objects = await storage.listByPrefix(prefix);
    const scanned = objects.length;

    const known = await withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ objectKey: schema.attachments.objectKey })
        .from(schema.attachments)
        .where(eq(schema.attachments.tenantId, tenantId));
      return new Set(rows.map((r) => r.objectKey));
    });

    const orphans = objects
      .map((o) => o.key)
      .filter((key) => !known.has(key));

    if (dryRun) {
      return {
        tenantId, scanned, orphans,
        deleted: 0, failed: 0,
        dryRun: true, aborted: false,
      };
    }

    const ratio = scanned === 0 ? 0 : orphans.length / scanned;
    if (ratio > 0.5 && !allowHigh) {
      return {
        tenantId, scanned, orphans,
        deleted: 0, failed: 0,
        dryRun: false, aborted: true,
        abortReason:
          'orphan ratio ' + ratio.toFixed(2) + ' exceeds 0.5; ' +
          'pass allowHighOrphanRatio: true after manual review',
      };
    }

    let deleted = 0;
    let failed = 0;
    for (const key of orphans) {
      try {
        await storage.delete(key);
        deleted += 1;
      } catch (err) {
        failed += 1;
        console.error('[maintenance] orphan delete failed for ' + key + ':', err);
      }
    }
    return {
      tenantId, scanned, orphans,
      deleted, failed,
      dryRun: false, aborted: false,
    };
  }

  /**
   * Deletes the attachments rows stuck in 'pending' longer than ttlDays
   * (default 7). A pending row means a client asked for a presigned PUT
   * URL and never confirmed the upload. There is no S3 object to clean:
   * either the client never PUT anything, or the object was written but
   * never confirmed, in which case scanTenantOrphans will find it later.
   *
   * Simple DELETE, no SECURITY DEFINER: sync_app holds the DELETE
   * privilege on attachments (migration 011), and RLS scopes the row set
   * to the tenant once withTenant has set the context.
   */
  async purgeTenantPendingAttachments(
    tenantId: string,
    ttlDays: number = 7,
  ): Promise<PurgePendingAttachmentsResult> {
    if (!tenantId) throw new Error('tenantId requis.');
    if (ttlDays < 0) throw new Error('ttlDays doit etre >= 0.');

    const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

    return withTenant(this.db, tenantId, async (tx) => {
      const removed = await tx
        .delete(schema.attachments)
        .where(and(
          eq(schema.attachments.tenantId, tenantId),
          eq(schema.attachments.status, 'pending'),
          lt(schema.attachments.createdAt, cutoffMs),
        ))
        .returning({ id: schema.attachments.id });
      return { deleted: removed.length };
    });
  }
}