import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from './schema.js';
import { lockTenantWrites } from './tenant-write-lock.js';
import { requireTenantId } from './tenant-id.js';

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
  version: number;
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

export interface PushConflict {
  entity_type: 'check_in';
  entity_id: string;
  client_version: number;
  server_version: number;
  conflict_id: string;
}

export interface PushResponse {
  applied: { created: number; updated: number; deleted: number };
  conflicts: PushConflict[];
}

const EMPTY_RESPONSE: PushResponse = {
  applied: { created: 0, updated: 0, deleted: 0 },
  conflicts: [],
};

export class SyncPushService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(db: NodePgDatabase<typeof schema>) {
    this.db = db;
  }

  async pushChanges(
    agentId: string,
    dto: SyncPushDto,
    idempotencyKey?: string,
    tenantIdRaw?: string,
  ): Promise<PushResponse> {
    if (!agentId) throw new BadRequestException('agentId requis.');
    const tenantId = requireTenantId(tenantIdRaw, 'tenantId (push)');

    const checkIns = dto.changes.check_ins;
    if (!checkIns) return { ...EMPTY_RESPONSE };

    const created = checkIns.created ?? [];
    const updated = checkIns.updated ?? [];
    const deleted = Array.from(new Set(checkIns.deleted ?? []));

    for (const item of updated) {
      if (item.version === undefined || item.version === null) {
        throw new BadRequestException('Update du check-in ' + item.id + ' sans version : refuse.');
      }
    }

    return await this.db.transaction(async (tx) => {
      await lockTenantWrites(tx, tenantId);

      if (idempotencyKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agentId} || ':' || ${idempotencyKey}))`);
        const existing = await tx.execute(
          sql`SELECT 1 FROM sync_idempotency_keys WHERE agent_id = ${agentId}::uuid AND idempotency_key = ${idempotencyKey}`,
        );
        if (existing.rows.length > 0) return { ...EMPTY_RESPONSE };
      }

      const response: PushResponse = { applied: { created: 0, updated: 0, deleted: 0 }, conflicts: [] };

      if (created.length > 0) {
        const missionIds = Array.from(new Set(created.map((item) => item.mission_id)));
        const validMissions = await tx
          .select({ id: schema.missions.id })
          .from(schema.missions)
          .where(and(inArray(schema.missions.id, missionIds), eq(schema.missions.agentId, agentId), eq(schema.missions.tenantId, tenantId)));

        if (validMissions.length !== missionIds.length) {
          throw new ForbiddenException('Creation refusee : mission non autorisee.');
        }

        for (const item of created) {
          const now = Date.now();

          const inserted = await tx
            .insert(schema.checkIns)
            .values({
              id: item.id,
              tenantId,
              missionId: item.mission_id,
              agentId,
              checkInTime: item.check_in_time,
              checkOutTime: item.check_out_time ?? null,
              checkInLat: item.check_in_lat,
              checkInLng: item.check_in_lng,
              checkInMethod: item.check_in_method,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              syncSeq: 0,
            })
            .onConflictDoNothing()
            .returning({ id: schema.checkIns.id });

          if (inserted.length === 1) {
            response.applied.created += 1;
            continue;
          }

          const existing = await tx.execute(sql`
            SELECT tenant_id, agent_id, deleted_at, sync_seq,
                   mission_id, check_in_time, check_out_time,
                   check_in_lat, check_in_lng, check_in_method
            FROM check_ins
            WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid
          `);
          const row = existing.rows[0] as Record<string, unknown> | undefined;

          if (!row) {
            throw new ForbiddenException('Creation refusee : etat incoherent pour ' + item.id + '.');
          }
          if (row.tenant_id !== tenantId || row.agent_id !== agentId) {
            throw new ForbiddenException('Creation refusee : check-in ' + item.id + ' appartient a un autre tenant ou agent.');
          }
          if (row.deleted_at !== null) {
            throw new ForbiddenException('Creation refusee : check-in ' + item.id + ' est supprime.');
          }

          const serverCOT = row.check_out_time === null ? null : Number(row.check_out_time);
          const clientCOT = item.check_out_time ?? null;
          const same =
            row.mission_id === item.mission_id &&
            Number(row.check_in_time) === item.check_in_time &&
            serverCOT === clientCOT &&
            Number(row.check_in_lat) === item.check_in_lat &&
            Number(row.check_in_lng) === item.check_in_lng &&
            row.check_in_method === item.check_in_method;

          if (same) continue;

          const serverVersion = Number(row.sync_seq);
          const conflictId = randomUUID();
          await tx.insert(schema.syncConflicts).values({
            id: conflictId,
            tenantId,
            agentId,
            entityType: 'check_in',
            entityId: item.id,
            clientVersion: 0,
            serverVersion,
            clientPayload: item as unknown as Record<string, unknown>,
            serverPayload: {
              id: item.id,
              mission_id: row.mission_id,
              check_in_time: Number(row.check_in_time),
              check_out_time: serverCOT,
              check_in_lat: Number(row.check_in_lat),
              check_in_lng: Number(row.check_in_lng),
              check_in_method: row.check_in_method,
              sync_seq: serverVersion,
            },
            status: 'pending',
            createdAt: Date.now(),
          });
          response.conflicts.push({
            entity_type: 'check_in',
            entity_id: item.id,
            client_version: 0,
            server_version: serverVersion,
            conflict_id: conflictId,
          });
        }
      }

      for (const item of updated) {
        if (item.mission_id !== undefined) {
          const target = await tx
            .select({ id: schema.missions.id })
            .from(schema.missions)
            .where(and(
              eq(schema.missions.id, item.mission_id),
              eq(schema.missions.agentId, agentId),
              eq(schema.missions.tenantId, tenantId),
            ));

          if (target.length !== 1) {
            throw new ForbiddenException('Update refuse : mission ' + item.mission_id + ' non autorisee pour cet agent.');
          }
        }

        const payload: Record<string, unknown> = { updatedAt: Date.now() };
        if (item.mission_id !== undefined) payload.missionId = item.mission_id;
        if (item.check_in_time !== undefined) payload.checkInTime = item.check_in_time;
        if (item.check_out_time !== undefined) payload.checkOutTime = item.check_out_time;
        if (item.check_in_lat !== undefined) payload.checkInLat = item.check_in_lat;
        if (item.check_in_lng !== undefined) payload.checkInLng = item.check_in_lng;
        if (item.check_in_method !== undefined) payload.checkInMethod = item.check_in_method;

        const result = await tx
          .update(schema.checkIns)
          .set(payload)
          .where(and(
            eq(schema.checkIns.id, item.id),
            eq(schema.checkIns.agentId, agentId),
            eq(schema.checkIns.tenantId, tenantId),
            isNull(schema.checkIns.deletedAt),
            eq(schema.checkIns.syncSeq, item.version),
          ))
          .returning({ syncSeq: schema.checkIns.syncSeq });

        if (result.length === 1) {
          response.applied.updated += 1;
          continue;
        }

        const existing = await tx.execute(sql`
          SELECT tenant_id, agent_id, deleted_at, sync_seq,
                 mission_id, check_in_time, check_out_time,
                 check_in_lat, check_in_lng, check_in_method
          FROM check_ins
          WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid
        `);
        const row = existing.rows[0] as Record<string, unknown> | undefined;

        if (!row) {
          throw new ForbiddenException('Update refuse : check-in ' + item.id + ' introuvable.');
        }
        if (row.tenant_id !== tenantId || row.agent_id !== agentId) {
          throw new ForbiddenException('Update refuse : check-in ' + item.id + ' appartient a un autre tenant ou agent.');
        }
        if (row.deleted_at !== null) {
          throw new ForbiddenException('Update refuse : check-in ' + item.id + ' supprime.');
        }

        const serverVersion = Number(row.sync_seq);
        const serverCOT = row.check_out_time === null ? null : Number(row.check_out_time);
        const conflictId = randomUUID();
        await tx.insert(schema.syncConflicts).values({
          id: conflictId,
          tenantId,
          agentId,
          entityType: 'check_in',
          entityId: item.id,
          clientVersion: item.version,
          serverVersion,
          clientPayload: item as unknown as Record<string, unknown>,
          serverPayload: {
            id: item.id,
            mission_id: row.mission_id,
            check_in_time: Number(row.check_in_time),
            check_out_time: serverCOT,
            check_in_lat: Number(row.check_in_lat),
            check_in_lng: Number(row.check_in_lng),
            check_in_method: row.check_in_method,
            sync_seq: serverVersion,
          },
          status: 'pending',
          createdAt: Date.now(),
        });
        response.conflicts.push({
          entity_type: 'check_in',
          entity_id: item.id,
          client_version: item.version,
          server_version: serverVersion,
          conflict_id: conflictId,
        });
      }

      if (deleted.length > 0) {
        const now = Date.now();
        const result = await tx
          .update(schema.checkIns)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(
            inArray(schema.checkIns.id, deleted),
            eq(schema.checkIns.agentId, agentId),
            eq(schema.checkIns.tenantId, tenantId),
            isNull(schema.checkIns.deletedAt),
          ))
          .returning({ id: schema.checkIns.id });

        if (result.length !== deleted.length) {
          throw new ForbiddenException('Suppression refusee : certains enregistrements sont absents, non possedes ou deja supprimes.');
        }
        response.applied.deleted = deleted.length;
      }

      if (idempotencyKey) {
        await tx.execute(sql`
          INSERT INTO sync_idempotency_keys (tenant_id, agent_id, idempotency_key)
          VALUES (${tenantId}::uuid, ${agentId}::uuid, ${idempotencyKey})
        `);
      }

      return response;
    });
  }
}