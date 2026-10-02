import { GoneException } from '@nestjs/common';
import { withTenant } from './with-tenant.js';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { requireTenantId } from './tenant-id.js';

export interface SyncPullDto {
  agentId: string;
  tenantId?: string;
  lastPulledAt?: number | null;
  limit?: number;
}

export interface SyncCheckInPayload {
  id: string;
  mission_id: string;
  check_in_time: number;
  check_out_time?: number | null;
  check_in_lat: number;
  check_in_lng: number;
  check_in_method: string;
}

export interface SyncMissionPayload {
  id: string;
  agent_id: string;
  site_id?: string | null;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface SyncSitePayload {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  created_at: number;
  updated_at: number;
}

interface SyncEventRow {
  entity_type: 'check_in' | 'mission' | 'site';

  id: string;

  mission_id: string | null;

  site_id: string | null;

  agent_id: string | null;

  title: string | null;

  name: string | null;

  latitude: number | null;

  longitude: number | null;

  check_in_time: number | null;

  check_out_time: number | null;

  check_in_lat: number | null;

  check_in_lng: number | null;

  check_in_method: string | null;

  created_at: number | null;

  updated_at: number | null;

  deleted_at: number | null;

  first_sync_seq: number | null;

  sync_seq: number;
}

export class SyncPullService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(db: NodePgDatabase<typeof schema>) {
    this.db = db;
  }

  async pullChanges(dto: SyncPullDto) {
    const agentId = dto.agentId;

    const sinceSeq = Number(dto.lastPulledAt ?? 0);
    const tenantId = requireTenantId(dto.tenantId);

    const requestedLimit = Number(dto.limit ?? 500);

    const safeLimit = Math.min(
      Math.max(requestedLimit, 1),
      1000,
    );

    return withTenant(this.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      WITH events AS (

        SELECT
          'check_in'::text AS entity_type,
          ci.id,
          ci.mission_id,
          NULL::uuid AS site_id,
          ci.agent_id,
          NULL::text AS title,
          NULL::text AS name,
          NULL::double precision AS latitude,
          NULL::double precision AS longitude,
          ci.check_in_time,
          ci.check_out_time,
          ci.check_in_lat,
          ci.check_in_lng,
          ci.check_in_method,
          ci.created_at,
          ci.updated_at,
          ci.deleted_at,
          NULL::bigint AS first_sync_seq,
          ci.sync_seq
        FROM check_ins ci
        WHERE ci.agent_id = ${agentId}
          AND ci.tenant_id = ${tenantId}::uuid
          AND ci.sync_seq > ${sinceSeq}

        UNION ALL

        SELECT
          'mission'::text AS entity_type,
          m.id,
          NULL::uuid AS mission_id,
          m.site_id,
          m.agent_id,
          m.title,
          NULL::text AS name,
          NULL::double precision AS latitude,
          NULL::double precision AS longitude,
          NULL::bigint AS check_in_time,
          NULL::bigint AS check_out_time,
          NULL::double precision AS check_in_lat,
          NULL::double precision AS check_in_lng,
          NULL::text AS check_in_method,
          m.created_at,
          m.updated_at,
          m.deleted_at,
          m.first_sync_seq,
          m.sync_seq
        FROM missions m
        WHERE m.agent_id = ${agentId}
          AND m.tenant_id = ${tenantId}::uuid
          AND m.sync_seq > ${sinceSeq}

        UNION ALL

        SELECT
          'site'::text AS entity_type,
          s.id,
          NULL::uuid AS mission_id,
          s.id AS site_id,
          NULL::uuid AS agent_id,
          NULL::text AS title,
          s.name,
          s.latitude,
          s.longitude,
          NULL::bigint AS check_in_time,
          NULL::bigint AS check_out_time,
          NULL::double precision AS check_in_lat,
          NULL::double precision AS check_in_lng,
          NULL::text AS check_in_method,
          s.created_at,
          s.updated_at,
          s.deleted_at,
          s.first_sync_seq,
          s.sync_seq
        FROM sites s
        WHERE s.tenant_id = ${tenantId}::uuid
          AND s.sync_seq > ${sinceSeq}
          AND EXISTS (
            SELECT 1
            FROM missions m
            WHERE m.agent_id = ${agentId}
              AND m.tenant_id = ${tenantId}::uuid
              AND m.site_id = s.id
          )
      )

      SELECT *
      FROM events
      ORDER BY sync_seq ASC, entity_type ASC, id ASC
      LIMIT ${safeLimit + 1}
    `);
    /*
     * Stale-cursor check (v0.5.2).
     *
     * Must run AFTER the data read above. The purge removes tombstones and
     * raises purged_up_to_seq in ONE transaction, so either it committed
     * before our read (the watermark is visible here -> 410) or after it
     * (our read still contained the tombstones). Cursor 0 is a full sync
     * and is never stale, otherwise a client could never recover.
     */
    if (sinceSeq > 0) {
      const purge = await tx.execute(sql`
        SELECT purged_up_to_seq
        FROM sync_purge_state
        WHERE tenant_id = ${tenantId}::uuid
      `);
      const raw = (purge.rows[0] as Record<string, unknown> | undefined)
        ?.purged_up_to_seq;
      const watermark = raw === null || raw === undefined ? 0 : Number(raw);

      if (sinceSeq < watermark) {
        throw new GoneException({
          statusCode: 410,
          error: 'Gone',
          code: 'CURSOR_TOO_OLD',
          message:
            'Cursor predates purged history; resync from scratch (last_pulled_at = 0).',
        });
      }
    }

    /*
     * PostgreSQL retourne les BIGINT sous forme de string avec pg.
     * Le curseur sync_seq doit rester numerique cote TypeScript.
     */
    const rows: SyncEventRow[] = result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;

      return {
        entity_type: row.entity_type as SyncEventRow['entity_type'],

        id: String(row.id),

        mission_id:
          row.mission_id === null || row.mission_id === undefined
            ? null
            : String(row.mission_id),

        site_id:
          row.site_id === null || row.site_id === undefined
            ? null
            : String(row.site_id),

        agent_id:
          row.agent_id === null || row.agent_id === undefined
            ? null
            : String(row.agent_id),

        title:
          row.title === null || row.title === undefined
            ? null
            : String(row.title),

        name:
          row.name === null || row.name === undefined
            ? null
            : String(row.name),

        latitude:
          row.latitude === null || row.latitude === undefined
            ? null
            : Number(row.latitude),

        longitude:
          row.longitude === null || row.longitude === undefined
            ? null
            : Number(row.longitude),

        check_in_time:
          row.check_in_time === null || row.check_in_time === undefined
            ? null
            : Number(row.check_in_time),

        check_out_time:
          row.check_out_time === null || row.check_out_time === undefined
            ? null
            : Number(row.check_out_time),

        check_in_lat:
          row.check_in_lat === null || row.check_in_lat === undefined
            ? null
            : Number(row.check_in_lat),

        check_in_lng:
          row.check_in_lng === null || row.check_in_lng === undefined
            ? null
            : Number(row.check_in_lng),

        check_in_method:
          row.check_in_method === null ||
          row.check_in_method === undefined
            ? null
            : String(row.check_in_method),

        created_at:
          row.created_at === null || row.created_at === undefined
            ? null
            : Number(row.created_at),

        updated_at:
          row.updated_at === null || row.updated_at === undefined
            ? null
            : Number(row.updated_at),

        deleted_at:
          row.deleted_at === null || row.deleted_at === undefined
            ? null
            : Number(row.deleted_at),

        first_sync_seq:
          row.first_sync_seq === null ||
          row.first_sync_seq === undefined
            ? null
            : Number(row.first_sync_seq),

        sync_seq: Number(row.sync_seq),
      };
    });

    const hasMore = rows.length > safeLimit;

    const consumedRows = hasMore
      ? rows.slice(0, safeLimit)
      : rows;

    const changes = {
      check_ins: {
        created: [] as SyncCheckInPayload[],
        updated: [] as SyncCheckInPayload[],
        deleted: [] as string[],
      },

      missions: {
        created: [] as SyncMissionPayload[],
        updated: [] as SyncMissionPayload[],
        deleted: [] as string[],
      },

      sites: {
        created: [] as SyncSitePayload[],
        updated: [] as SyncSitePayload[],
        deleted: [] as string[],
      },
    };

    for (const row of consumedRows) {
      if (row.deleted_at !== null) {
        if (row.entity_type === 'check_in') {
          changes.check_ins.deleted.push(row.id);
        }
        else if (row.entity_type === 'mission') {
          changes.missions.deleted.push(row.id);
        }
        else {
          changes.sites.deleted.push(row.id);
        }

        continue;
      }

      if (row.entity_type === 'check_in') {
        const payload: SyncCheckInPayload = {
          id: row.id,
          mission_id: row.mission_id!,
          check_in_time: row.check_in_time!,
          check_out_time: row.check_out_time,
          check_in_lat: row.check_in_lat!,
          check_in_lng: row.check_in_lng!,
          check_in_method: row.check_in_method!,
        };

        if (row.created_at === row.updated_at) {
          changes.check_ins.created.push(payload);
        }
        else {
          changes.check_ins.updated.push(payload);
        }

        continue;
      }

      if (row.entity_type === 'mission') {
        const payload: SyncMissionPayload = {
          id: row.id,
          agent_id: row.agent_id!,
          site_id: row.site_id,
          title: row.title!,
          created_at: row.created_at!,
          updated_at: row.updated_at!,
        };

        if (
          row.first_sync_seq !== null &&
          Number(row.first_sync_seq) > sinceSeq
        ) {
          changes.missions.created.push(payload);
        }
        else {
          changes.missions.updated.push(payload);
        }

        continue;
      }

      if (row.entity_type === 'site') {
        const payload: SyncSitePayload = {
          id: row.id,
          name: row.name!,
          latitude: row.latitude!,
          longitude: row.longitude!,
          created_at: row.created_at!,
          updated_at: row.updated_at!,
        };

        if (
          row.first_sync_seq !== null &&
          Number(row.first_sync_seq) > sinceSeq
        ) {
          changes.sites.created.push(payload);
        }
        else {
          changes.sites.updated.push(payload);
        }
      }
    }

    const timestamp =
      consumedRows.length > 0
        ? Number(consumedRows[consumedRows.length - 1].sync_seq)
        : sinceSeq;

    return {
      timestamp,
      has_more: hasMore,
      changes,
    };
    });
  }
}