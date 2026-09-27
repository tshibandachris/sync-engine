import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type CheckInMethod = 'GPS' | 'QR_CODE' | 'MANUAL';

export interface CreateCheckIn {
  id: string;
  mission_id: string;
  check_in_time: number;
  check_out_time?: number;
  check_in_lat: number;
  check_in_lng: number;
  check_in_method: CheckInMethod;
}

export interface UpdateCheckIn {
  id: string;
  mission_id?: string;
  check_in_time?: number;
  check_out_time?: number;
  check_in_lat?: number;
  check_in_lng?: number;
  check_in_method?: CheckInMethod;
}

export interface SyncPushDto {
  last_pulled_at?: number | null;
  changes: {
    check_ins?: {
      created?: CreateCheckIn[];
      updated?: UpdateCheckIn[];
      deleted?: string[];
    };
  };
}

export class SyncPushService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(db: NodePgDatabase<typeof schema>) {
    this.db = db;
  }

  async pushChanges(agentId: string, dto: SyncPushDto, idempotencyKey?: string): Promise<void> {
    if (!agentId) throw new BadRequestException('agentId requis.');
    const checkIns = dto.changes.check_ins;
    if (!checkIns) return;

    const created = checkIns.created ?? [];
    const updated = checkIns.updated ?? [];
    const deleted = Array.from(new Set(checkIns.deleted ?? []));

    await this.db.transaction(async (tx) => {
            if (idempotencyKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agentId} || ':' || ${idempotencyKey}))`);
        const existing = await tx.execute(
          sql`SELECT 1 FROM sync_idempotency_keys WHERE agent_id = ${agentId}::uuid AND idempotency_key = ${idempotencyKey}`
        );
        if (existing.rows.length > 0) return;
      }
      if (created.length > 0) {
        const missionIds = Array.from(new Set(created.map((item) => item.mission_id)));
        const validMissions = await tx
          .select({ id: schema.missions.id })
          .from(schema.missions)
          .where(and(inArray(schema.missions.id, missionIds), eq(schema.missions.agentId, agentId)));

        if (validMissions.length !== missionIds.length) {
          throw new ForbiddenException('CrÃ©ation refusÃ©e : mission non autorisÃ©e.');
        }

        const now = Date.now();
        await tx.insert(schema.checkIns).values(
          created.map((item) => ({
            id: item.id,
            missionId: item.mission_id,
            agentId,
            checkInTime: item.check_in_time,
            checkOutTime: item.check_out_time,
            checkInLat: item.check_in_lat,
            checkInLng: item.check_in_lng,
            checkInMethod: item.check_in_method,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            syncSeq: 0,
          })),
        ).onConflictDoUpdate({
          target: schema.checkIns.id,
          set: {
            missionId: sql`excluded.mission_id`,
            checkInTime: sql`excluded.check_in_time`,
            checkOutTime: sql`excluded.check_out_time`,
            checkInLat: sql`excluded.check_in_lat`,
            checkInLng: sql`excluded.check_in_lng`,
            checkInMethod: sql`excluded.check_in_method`,
            updatedAt: now,
          },
          setWhere: isNull(schema.checkIns.deletedAt),
        });
      }

      for (const item of updated) {
        const payload: Record<string, unknown> = { updatedAt: Date.now() };
        if (item.mission_id !== undefined) payload.missionId = item.mission_id;
        if (item.check_in_time !== undefined) payload.checkInTime = item.check_in_time;
        if (item.check_out_time !== undefined) payload.checkOutTime = item.check_out_time;
        if (item.check_in_lat !== undefined) payload.checkInLat = item.check_in_lat;
        if (item.check_in_lng !== undefined) payload.checkInLng = item.check_in_lng;
        if (item.check_in_method !== undefined) payload.checkInMethod = item.check_in_method;

        const result = await tx.update(schema.checkIns).set(payload).where(
          and(eq(schema.checkIns.id, item.id), eq(schema.checkIns.agentId, agentId), isNull(schema.checkIns.deletedAt)),
        );
        if (result.rowCount !== 1) {
          throw new ForbiddenException(`Mise Ã  jour refusÃ©e pour ${item.id}.`);
        }
      }

      if (deleted.length > 0) {
        const now = Date.now();
        const result = await tx.update(schema.checkIns).set({ deletedAt: now, updatedAt: now }).where(
          and(inArray(schema.checkIns.id, deleted), eq(schema.checkIns.agentId, agentId), isNull(schema.checkIns.deletedAt)),
        );
        if (result.rowCount !== deleted.length) {
          throw new ForbiddenException('Suppression refusÃ©e : certains enregistrements sont absents, non possÃ©dÃ©s ou dÃ©jÃ  supprimÃ©s.');
        }
      }
           if (idempotencyKey) {
        await tx.execute(sql`
          INSERT INTO sync_idempotency_keys (agent_id, idempotency_key)
          VALUES (${agentId}::uuid, ${idempotencyKey})
        `);
      }
    });
  }
}
