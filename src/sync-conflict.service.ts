import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Resolution = 'client' | 'server' | 'dismiss';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface ListConflictsDto {
  agentId: string;
  tenantId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ConflictRow {
  id: string;
  agentId: string;
  entityType: string;
  entityId: string;
  clientVersion: number;
  serverVersion: number;
  clientPayload: Record<string, unknown>;
  serverPayload: Record<string, unknown>;
  status: string;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
}

export interface ResolveConflictDto {
  conflictId: string;
  agentId: string;
  tenantId?: string;
  resolution: Resolution;
  resolvedBy: string;
}

export class SyncConflictService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(db: NodePgDatabase<typeof schema>) {
    this.db = db;
  }

  async listConflicts(dto: ListConflictsDto): Promise<ConflictRow[]> {
    const limit = Math.min(Math.max(dto.limit ?? 100, 1), 500);
    const offset = Math.max(dto.offset ?? 0, 0);
    const tenantId = dto.tenantId ?? DEFAULT_TENANT_ID;

    const whereClause = dto.status
      ? and(eq(schema.syncConflicts.tenantId, tenantId), eq(schema.syncConflicts.agentId, dto.agentId), eq(schema.syncConflicts.status, dto.status))
      : and(eq(schema.syncConflicts.tenantId, tenantId), eq(schema.syncConflicts.agentId, dto.agentId));

    const rows = await this.db
      .select()
      .from(schema.syncConflicts)
      .where(whereClause)
      .orderBy(desc(schema.syncConflicts.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      entityType: r.entityType,
      entityId: r.entityId,
      clientVersion: Number(r.clientVersion),
      serverVersion: Number(r.serverVersion),
      clientPayload: r.clientPayload as Record<string, unknown>,
      serverPayload: r.serverPayload as Record<string, unknown>,
      status: r.status,
      resolution: r.resolution ?? null,
      resolvedBy: r.resolvedBy ?? null,
      resolvedAt: r.resolvedAt === null || r.resolvedAt === undefined ? null : Number(r.resolvedAt),
      createdAt: Number(r.createdAt),
    }));
  }

  async resolveConflict(dto: ResolveConflictDto): Promise<void> {
    if (!dto.agentId) throw new BadRequestException('agentId requis.');
    if (!dto.conflictId) throw new BadRequestException('conflictId requis.');
    if (!dto.resolvedBy) throw new BadRequestException('resolvedBy requis.');
    if (dto.resolution !== 'client' && dto.resolution !== 'server' && dto.resolution !== 'dismiss') {
      throw new BadRequestException('resolution invalide.');
    }
    const tenantId = dto.tenantId ?? DEFAULT_TENANT_ID;

    await this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, tenant_id, agent_id, entity_type, entity_id, status, client_payload
        FROM sync_conflicts
        WHERE id = ${dto.conflictId}::uuid
        FOR UPDATE
      `);

      const conflict = locked.rows[0] as Record<string, unknown> | undefined;

      if (!conflict) throw new NotFoundException('Conflit introuvable.');
      if (conflict.tenant_id !== tenantId || conflict.agent_id !== dto.agentId) throw new ForbiddenException('Conflit non accessible.');
      if (conflict.status !== 'pending') throw new ConflictException('Conflit deja resolu.');
      if (conflict.entity_type !== 'check_in') throw new BadRequestException('entity_type non supporte.');

      if (dto.resolution === 'client') {
        await this.applyClientPayload(
          tx,
          tenantId,
          dto.agentId,
          String(conflict.entity_id),
          conflict.client_payload as Record<string, unknown>,
        );
      }

      await tx
        .update(schema.syncConflicts)
        .set({
          status: 'resolved',
          resolution: dto.resolution,
          resolvedBy: dto.resolvedBy,
          resolvedAt: Date.now(),
        })
        .where(and(eq(schema.syncConflicts.id, dto.conflictId), eq(schema.syncConflicts.tenantId, tenantId)));
    });
  }

  private async applyClientPayload(
    tx: any,
    tenantId: string,
    agentId: string,
    checkInId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const target = await tx
      .select({ id: schema.checkIns.id, agentId: schema.checkIns.agentId })
      .from(schema.checkIns)
      .where(and(eq(schema.checkIns.id, checkInId), eq(schema.checkIns.tenantId, tenantId)));

    if (target.length === 0) throw new NotFoundException('Check-in cible introuvable.');
    if (target[0].agentId !== agentId) throw new ForbiddenException('Check-in non accessible.');

    if (payload.mission_id !== undefined) {
      const m = await tx
        .select({ id: schema.missions.id })
        .from(schema.missions)
        .where(and(
          eq(schema.missions.id, String(payload.mission_id)),
          eq(schema.missions.agentId, agentId),
          eq(schema.missions.tenantId, tenantId),
        ));

      if (m.length !== 1) throw new ForbiddenException('Resolution refusee : mission non autorisee.');
    }

    const fields: Record<string, unknown> = { updatedAt: Date.now() };
    if (payload.mission_id !== undefined) fields.missionId = payload.mission_id;
    if (payload.check_in_time !== undefined) fields.checkInTime = payload.check_in_time;
    if (payload.check_out_time !== undefined) fields.checkOutTime = payload.check_out_time;
    if (payload.check_in_lat !== undefined) fields.checkInLat = payload.check_in_lat;
    if (payload.check_in_lng !== undefined) fields.checkInLng = payload.check_in_lng;
    if (payload.check_in_method !== undefined) fields.checkInMethod = payload.check_in_method;

    await tx.update(schema.checkIns).set(fields).where(and(eq(schema.checkIns.id, checkInId), eq(schema.checkIns.tenantId, tenantId)));
  }
}