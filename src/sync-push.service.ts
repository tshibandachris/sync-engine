import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from './schema.js';
import { withTenant } from './with-tenant.js';
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

export interface ProductUpsert {
  id: string; name: string; sku?: string | null; barcode?: string | null;
  category?: string | null; price: number; cost?: number | null;
  stockAlert?: number; isActive?: boolean; createdAt?: number;
  deletedAt?: number | null; lastKnownSyncSeq: number;
}
export interface ProductPushResult {
  entity_id: string; status: 'applied' | 'idempotent' | 'conflict' | 'invalid';
  sync_seq?: number; errors?: string[];
}
export interface SyncPushDto {
  last_pulled_at?: number | null;
  changes: {
    check_ins?: { created?: CreateCheckIn[]; updated?: UpdateCheckIn[]; deleted?: string[] };
    products?: ProductUpsert[];
  };
}

export interface PushConflict {
  entity_type: 'check_in';
  entity_id: string;
  client_version: number;
  server_version: number;
  conflict_id: string;
}

/**
 * Marqueur non serialisable pose sur la reponse quand le push est un
 * replay idempotent (Idempotency-Key deja vu). Un Symbol, et non un
 * booleen, pour que la reponse HTTP reste strictement identique entre
 * un push frais et un replay : le client ne doit rien voir.
 *
 * Lu par SyncLogInterceptor pour poser idempotency='hit' en base et
 * dans Prometheus.
 */
export const IDEMPOTENCY_REPLAY = Symbol('idempotencyReplay');

export interface PushResponse {
  applied: { created: number; updated: number; deleted: number };
  conflicts: PushConflict[];
  products?: ProductPushResult[];
}

const EMPTY_RESPONSE: PushResponse = {
  applied: { created: 0, updated: 0, deleted: 0 },
  conflicts: [],
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const optionalText = (value: unknown, max: number) => value === undefined || value === null || (typeof value === 'string' && value.length <= max);
function validateProduct(p: ProductUpsert): string[] {
  const errors: string[] = [];
  if (!p || typeof p !== 'object') return ['payload doit être un objet'];
  if (typeof p.id !== 'string' || !UUID_RE.test(p.id)) errors.push('id doit être un UUID valide');
  if (typeof p.name !== 'string' || p.name.trim().length < 1 || p.name.length > 200) errors.push('name doit contenir entre 1 et 200 caractères');
  if (!optionalText(p.sku, 64)) errors.push('sku doit contenir au plus 64 caractères');
  if (!optionalText(p.barcode, 64)) errors.push('barcode doit contenir au plus 64 caractères');
  if (!optionalText(p.category, 80)) errors.push('category doit contenir au plus 80 caractères');
  if (!Number.isSafeInteger(p.price) || p.price < 0) errors.push('price doit être un entier positif ou nul');
  if (!(p.cost === undefined || p.cost === null || (Number.isSafeInteger(p.cost) && p.cost >= 0))) errors.push('cost doit être un entier positif ou nul');
  if (!(p.stockAlert === undefined || (Number.isSafeInteger(p.stockAlert) && p.stockAlert >= 0))) errors.push('stockAlert doit être un entier positif ou nul');
  if (!(p.isActive === undefined || typeof p.isActive === 'boolean')) errors.push('isActive doit être booléen');
  if (!(p.createdAt === undefined || (Number.isSafeInteger(p.createdAt) && p.createdAt >= 0))) errors.push('createdAt doit être un timestamp entier positif ou nul');
  if (!(p.deletedAt === undefined || p.deletedAt === null || (Number.isSafeInteger(p.deletedAt) && p.deletedAt >= 0))) errors.push('deletedAt doit être null ou un timestamp entier positif ou nul');
  if (!Number.isSafeInteger(p.lastKnownSyncSeq) || p.lastKnownSyncSeq < 0) errors.push('lastKnownSyncSeq doit être un entier positif ou nul');
  return errors;
}
function productFields(p: ProductUpsert) {
  return { name: p.name.trim(), sku: p.sku ?? null, barcode: p.barcode ?? null,
    category: p.category ?? null, price: p.price, cost: p.cost ?? null,
    stockAlert: p.stockAlert ?? 5, isActive: p.isActive ?? true, deletedAt: p.deletedAt ?? null };
}

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

    const checkIns = dto.changes.check_ins ?? {};
    const productResults: ProductPushResult[] = [];
    const rawProducts: unknown = dto.changes.products ?? [];
    const incomingProducts: ProductUpsert[] = Array.isArray(rawProducts) ? rawProducts as ProductUpsert[] : [];
    if (!Array.isArray(rawProducts)) productResults.push({ entity_id: '', status: 'invalid', errors: ['changes.products doit être un tableau'] });
    const validProducts: ProductUpsert[] = [];
    for (const item of incomingProducts) {
      const errors = validateProduct(item);
      if (errors.length) productResults.push({ entity_id: typeof item?.id === 'string' ? item.id : '', status: 'invalid', errors });
      else validProducts.push(item);
    }

    const created = checkIns.created ?? [];
    const updated = checkIns.updated ?? [];
    const deleted = Array.from(new Set(checkIns.deleted ?? []));

    for (const item of updated) {
      if (item.version === undefined || item.version === null) {
        throw new BadRequestException('Update du check-in ' + item.id + ' sans version : refuse.');
      }
    }

    return await withTenant(this.db, tenantId, async (tx) => {

      if (idempotencyKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agentId} || ':' || ${idempotencyKey}))`);
        const existing = await tx.execute(
          sql`SELECT 1 FROM sync_idempotency_keys WHERE agent_id = ${agentId}::uuid AND idempotency_key = ${idempotencyKey}`,
        );
        if (existing.rows.length > 0) return { ...EMPTY_RESPONSE, [IDEMPOTENCY_REPLAY]: true };
      }

      const response: PushResponse = { applied: { created: 0, updated: 0, deleted: 0 }, conflicts: [] };
      if ((Array.isArray(rawProducts) && rawProducts.length > 0) || productResults.length > 0) response.products = [...productResults];

      if (created.length > 0) {
        const missionIds = Array.from(new Set(created.map((item) => item.mission_id)));
        const validMissions = await tx
          .select({ id: schema.missions.id, siteId: schema.missions.siteId })
          .from(schema.missions)
          .where(and(inArray(schema.missions.id, missionIds), eq(schema.missions.agentId, agentId), eq(schema.missions.tenantId, tenantId)));

        if (validMissions.length !== missionIds.length) {
          throw new ForbiddenException('Creation refusee : mission non autorisee.');
        }

        const siteByMission = new Map(validMissions.map((m) => [m.id, m.siteId]));

        for (const item of created) {
          const now = Date.now();

          const inserted = await tx
            .insert(schema.checkIns)
            .values({
              id: item.id,
              tenantId,
              missionId: item.mission_id,
              siteId: siteByMission.get(item.mission_id) ?? null,
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

      for (const item of validProducts) {
        const b = productFields(item);
        const found = await tx.execute(sql`
          SELECT id, name, sku, barcode, category, price, cost, stock_alert, is_active, deleted_at, sync_seq
          FROM products WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid
        `);
        let row = found.rows[0] as Record<string, unknown> | undefined;
        if (!row) {
          const inserted = await tx.execute(sql`
            INSERT INTO products (id, tenant_id, name, sku, barcode, category, price, cost, stock_alert, is_active, created_at, updated_at, deleted_at, sync_seq, first_sync_seq)
            VALUES (${item.id}::uuid, ${tenantId}::uuid, ${b.name}, ${b.sku}, ${b.barcode}, ${b.category}, ${b.price}, ${b.cost}, ${b.stockAlert}, ${b.isActive}, ${item.createdAt ?? Date.now()}, ${Date.now()}, ${b.deletedAt}, 0, 0)
            ON CONFLICT (id) DO NOTHING RETURNING id, sync_seq
          `);
          const createdRow = inserted.rows[0] as Record<string, unknown> | undefined;
          if (createdRow) {
            response.products!.push({ entity_id: item.id, status: 'applied', sync_seq: Number(createdRow.sync_seq) });
            continue;
          }
          const retry = await tx.execute(sql`
            SELECT id, name, sku, barcode, category, price, cost, stock_alert, is_active, deleted_at, sync_seq
            FROM products WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid
          `);
          row = retry.rows[0] as Record<string, unknown> | undefined;
          if (!row) {
            response.products!.push({ entity_id: item.id, status: 'conflict', errors: ['UUID déjà utilisé ou produit inaccessible dans ce tenant'] });
            continue;
          }
        }
        const sameFields = (r: Record<string, unknown>) =>
          r.name === b.name && (r.sku ?? null) === b.sku && (r.barcode ?? null) === b.barcode &&
          (r.category ?? null) === b.category && Number(r.price) === b.price &&
          (r.cost === null ? null : Number(r.cost)) === b.cost &&
          Number(r.stock_alert) === b.stockAlert && r.is_active === b.isActive &&
          (r.deleted_at === null ? null : Number(r.deleted_at)) === b.deletedAt;
        const currentSeq = Number(row.sync_seq);
        if (currentSeq !== item.lastKnownSyncSeq) {
          response.products!.push(sameFields(row)
            ? { entity_id: item.id, status: 'idempotent', sync_seq: currentSeq }
            : { entity_id: item.id, status: 'conflict', sync_seq: currentSeq });
          continue;
        }
        const updatedProduct = await tx.execute(sql`
          UPDATE products SET name = ${b.name}, sku = ${b.sku}, barcode = ${b.barcode},
            category = ${b.category}, price = ${b.price}, cost = ${b.cost},
            stock_alert = ${b.stockAlert}, is_active = ${b.isActive}, deleted_at = ${b.deletedAt}
          WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid AND sync_seq = ${item.lastKnownSyncSeq}
          RETURNING sync_seq
        `);
        if (updatedProduct.rows.length) {
          response.products!.push({ entity_id: item.id, status: 'applied', sync_seq: Number((updatedProduct.rows[0] as Record<string, unknown>).sync_seq) });
        } else {
          const latest = await tx.execute(sql`
            SELECT name, sku, barcode, category, price, cost, stock_alert, is_active, deleted_at, sync_seq
            FROM products WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid
          `);
          const latestRow = latest.rows[0] as Record<string, unknown> | undefined;
          if (!latestRow) response.products!.push({ entity_id: item.id, status: 'conflict', errors: ['Produit introuvable ou inaccessible'] });
          else response.products!.push(sameFields(latestRow)
            ? { entity_id: item.id, status: 'idempotent', sync_seq: Number(latestRow.sync_seq) }
            : { entity_id: item.id, status: 'conflict', sync_seq: Number(latestRow.sync_seq) });
        }
      }

      if (idempotencyKey) {
        await tx.execute(sql`
          INSERT INTO sync_idempotency_keys (tenant_id, agent_id, idempotency_key)
          VALUES (${tenantId}::uuid, ${agentId}::uuid, ${idempotencyKey})
        `);
      }

      return response;
    }, { write: true });
  }
}