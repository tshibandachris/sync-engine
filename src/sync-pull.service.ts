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
  entity_type: 'check_in' | 'mission' | 'site' | 'product' | 'staff' | 'cash_session';

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
  sku: string | null; barcode: string | null; category: string | null;
  price: number | null; cost: number | null; stock_alert: number | null; is_active: boolean | null;
  staff_role: string | null;
  cash_staff_id: string | null;
  terminal_label: string | null;
  opened_at: number | null;
  closed_at: number | null;
  opening_amount: number | null;
  closing_amount: number | null;
  expected_amount: number | null;
  difference: number | null;
  session_status: string | null;
  notes: string | null;
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
        -- The cursor and sequence metadata stay relational; entity-specific
        -- fields live in one JSONB payload per event. Each branch uses an
        -- explicit allowlist, and deleted rows use this exact same projection.
        SELECT
          'check_in'::text AS entity_type,
          ci.id,
          ci.created_at,
          ci.updated_at,
          ci.deleted_at,
          NULL::bigint AS first_sync_seq,
          ci.sync_seq,
          jsonb_build_object(
            'mission_id', ci.mission_id,
            'agent_id', ci.agent_id,
            'check_in_time', ci.check_in_time,
            'check_out_time', ci.check_out_time,
            'check_in_lat', ci.check_in_lat,
            'check_in_lng', ci.check_in_lng,
            'check_in_method', ci.check_in_method
          ) AS payload
        FROM check_ins ci
        WHERE ci.agent_id = ${agentId}
          AND ci.tenant_id = ${tenantId}::uuid
          AND ci.sync_seq > ${sinceSeq}

        UNION ALL

        SELECT
          'mission'::text AS entity_type,
          m.id,
          m.created_at,
          m.updated_at,
          m.deleted_at,
          m.first_sync_seq,
          m.sync_seq,
          jsonb_build_object(
            'site_id', m.site_id,
            'agent_id', m.agent_id,
            'title', m.title
          ) AS payload
        FROM missions m
        WHERE m.agent_id = ${agentId}
          AND m.tenant_id = ${tenantId}::uuid
          AND m.sync_seq > ${sinceSeq}

        UNION ALL

        SELECT
          'site'::text AS entity_type,
          s.id,
          s.created_at,
          s.updated_at,
          s.deleted_at,
          s.first_sync_seq,
          s.sync_seq,
          jsonb_build_object(
            'site_id', s.id,
            'name', s.name,
            'latitude', s.latitude,
            'longitude', s.longitude
          ) AS payload
        FROM sites s
        WHERE s.tenant_id = ${tenantId}::uuid
          AND s.sync_seq > ${sinceSeq}
          AND (
            EXISTS (
              SELECT 1
              FROM missions m
              WHERE m.agent_id = ${agentId}
                AND m.tenant_id = ${tenantId}::uuid
                AND m.site_id = s.id
            )
            OR EXISTS (
              SELECT 1
              FROM check_ins ci
              WHERE ci.agent_id = ${agentId}
                AND ci.tenant_id = ${tenantId}::uuid
                AND ci.site_id = s.id
            )
          )

        UNION ALL

        SELECT
          'product'::text AS entity_type,
          p.id,
          p.created_at,
          p.updated_at,
          p.deleted_at,
          p.first_sync_seq,
          p.sync_seq,
          jsonb_build_object(
            'name', p.name,
            'sku', p.sku,
            'barcode', p.barcode,
            'category', p.category,
            'price', p.price,
            'cost', p.cost,
            'stock_alert', p.stock_alert,
            'is_active', p.is_active
          ) AS payload
        FROM products p
        WHERE p.tenant_id = ${tenantId}::uuid
          AND p.sync_seq > ${sinceSeq}

        UNION ALL

        -- Safe staff projection: credential/authentication columns are deliberately excluded.
        SELECT
          'staff'::text AS entity_type,
          st.id,
          st.created_at,
          st.updated_at,
          st.deleted_at,
          st.first_sync_seq,
          st.sync_seq,
          jsonb_build_object(
            'name', st.display_name,
            'staff_role', st.role,
            'is_active', st.is_active
          ) AS payload
        FROM staff st
        WHERE st.tenant_id = ${tenantId}::uuid
          AND st.sync_seq > ${sinceSeq}
        UNION ALL

        SELECT
          'cash_session'::text AS entity_type,
          cs.id,
          cs.created_at,
          cs.updated_at,
          NULL::bigint AS deleted_at,
          cs.first_sync_seq,
          cs.sync_seq,
          jsonb_build_object(
            'cash_staff_id', cs.staff_id,
            'terminal_label', cs.terminal_label,
            'opened_at', cs.opened_at,
            'closed_at', cs.closed_at,
            'opening_amount', cs.opening_amount,
            'closing_amount', cs.closing_amount,
            'expected_amount', cs.expected_amount,
            'difference', cs.difference,
            'session_status', cs.status,
            'notes', cs.notes
          ) AS payload
        FROM cash_sessions cs
        WHERE cs.tenant_id = ${tenantId}::uuid
          AND cs.sync_seq > ${sinceSeq}
      )

      SELECT
        entity_type,
        id,
        created_at,
        updated_at,
        deleted_at,
        first_sync_seq,
        sync_seq,
        payload
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
      const payload =
        row.payload && typeof row.payload === 'object'
          ? row.payload as Record<string, unknown>
          : {};
      const value = (key: string): unknown => payload[key] ?? null;
      const nullableString = (key: string): string | null => {
        const v = value(key);
        return v === null ? null : String(v);
      };
      const nullableNumber = (key: string): number | null => {
        const v = value(key);
        return v === null ? null : Number(v);
      };

      return {
        entity_type: row.entity_type as SyncEventRow['entity_type'],
        id: String(row.id),
        mission_id: nullableString('mission_id'),
        site_id: nullableString('site_id'),
        agent_id: nullableString('agent_id'),
        title: nullableString('title'),
        name: nullableString('name'),
        latitude: nullableNumber('latitude'),
        longitude: nullableNumber('longitude'),
        check_in_time: nullableNumber('check_in_time'),
        check_out_time: nullableNumber('check_out_time'),
        check_in_lat: nullableNumber('check_in_lat'),
        check_in_lng: nullableNumber('check_in_lng'),
        check_in_method: nullableString('check_in_method'),
        created_at: row.created_at === null || row.created_at === undefined
          ? null : Number(row.created_at),
        updated_at: row.updated_at === null || row.updated_at === undefined
          ? null : Number(row.updated_at),
        deleted_at: row.deleted_at === null || row.deleted_at === undefined
          ? null : Number(row.deleted_at),
        first_sync_seq: row.first_sync_seq === null || row.first_sync_seq === undefined
          ? null : Number(row.first_sync_seq),
        sync_seq: Number(row.sync_seq),
        sku: nullableString('sku'),
        barcode: nullableString('barcode'),
        category: nullableString('category'),
        price: nullableNumber('price'),
        cost: nullableNumber('cost'),
        stock_alert: nullableNumber('stock_alert'),
        is_active: (() => {
          const v = value('is_active');
          return v === null ? null : Boolean(v);
        })(),
        staff_role: nullableString('staff_role'),
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
      products: { created: [] as Record<string, unknown>[], updated: [] as Record<string, unknown>[], deleted: [] as Record<string, unknown>[] },
      staff: { created: [] as Record<string, unknown>[], updated: [] as Record<string, unknown>[], deleted: [] as Record<string, unknown>[] },
    };

    for (const row of consumedRows) {
      if (row.deleted_at !== null) {
        if (row.entity_type === 'check_in') {
          changes.check_ins.deleted.push(row.id);
        }
        else if (row.entity_type === 'mission') {
          changes.missions.deleted.push(row.id);
        }
        else if (row.entity_type === 'site') {
          changes.sites.deleted.push(row.id);
        } else if (row.entity_type === 'product') {
          changes.products.deleted.push({
            id: row.id, name: row.name!, sku: row.sku, barcode: row.barcode, category: row.category,
            price: row.price!, cost: row.cost, stockAlert: row.stock_alert!, isActive: row.is_active!,
            createdAt: row.created_at!, updatedAt: row.updated_at!, deletedAt: row.deleted_at,
            lastKnownSyncSeq: row.sync_seq,
          });
        } else {
          changes.staff.deleted.push({
            id: row.id,
            displayName: row.name!,
            role: row.staff_role!,
            isActive: row.is_active!,
            createdAt: row.created_at!,
            updatedAt: row.updated_at!,
            deletedAt: row.deleted_at,
            lastKnownSyncSeq: row.sync_seq,
          });
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

      if (row.entity_type === 'product') {
        const payload = {
          id: row.id, name: row.name!, sku: row.sku, barcode: row.barcode, category: row.category,
          price: row.price!, cost: row.cost, stockAlert: row.stock_alert!, isActive: row.is_active!,
          createdAt: row.created_at!, updatedAt: row.updated_at!, deletedAt: row.deleted_at,
          lastKnownSyncSeq: row.sync_seq,
        };
        if (row.first_sync_seq !== null && row.first_sync_seq > sinceSeq) changes.products.created.push(payload);
        else changes.products.updated.push(payload);
        continue;
      }

      if (row.entity_type === 'staff') {
        const payload = {
          id: row.id,
          displayName: row.name!,
          role: row.staff_role!,
          isActive: row.is_active!,
          createdAt: row.created_at!,
          updatedAt: row.updated_at!,
          deletedAt: row.deleted_at,
          lastKnownSyncSeq: row.sync_seq,
        };
        if (row.first_sync_seq !== null && row.first_sync_seq > sinceSeq) {
          changes.staff.created.push(payload);
        } else {
          changes.staff.updated.push(payload);
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