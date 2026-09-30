import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export interface PurgeResult {
  idempotencyDeleted: number;
  conflictsDeleted: number;
}

export interface PurgeOptions {
  ttlIdempotencyDays?: number;
  ttlConflictsDays?: number;
}

export interface PurgeTombstonesResult {
  checkInsDeleted: number;
  missionsDeleted: number;
  sitesDeleted: number;
  purgedUpToSeq: number;
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

    const result = await this.db.execute(sql`
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
    };
  }
}