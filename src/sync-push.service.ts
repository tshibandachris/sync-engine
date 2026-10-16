import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from './schema.js';
import { withTenant } from './with-tenant.js';
import { requireTenantId } from './tenant-id.js';
import { productUpsertSchema, type ProductUpsert } from './pos/schemas/product.schema.js';
import { staffUpsertSchema, type StaffUpsert } from './pos/schemas/staff.schema.js';

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

export interface ProductPushResult {
  entity_id: string; status: 'applied' | 'idempotent' | 'conflict' | 'invalid';
  sync_seq?: number; errors?: string[];
}
export interface SyncPushDto {
  last_pulled_at?: number | null;
  changes: {
    check_ins?: { created?: CreateCheckIn[]; updated?: UpdateCheckIn[]; deleted?: string[] };
    products?: ProductUpsert[];
    staff?: StaffUpsert[];
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

export interface StaffPushResult {
  entity_id: string;
  status: 'applied' | 'idempotent' | 'conflict';
  sync_seq?: number;
  errors?: string[];
}

export interface PushResponse {
  applied: { created: number; updated: number; deleted: number };
  conflicts: PushConflict[];
  products?: ProductPushResult[];
  staff?: StaffPushResult[];
}

const EMPTY_RESPONSE: PushResponse = {
  applied: { created: 0, updated: 0, deleted: 0 },
  conflicts: [],
};
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
    const incomingProducts: unknown[] = Array.isArray(rawProducts) ? rawProducts : [];
    if (!Array.isArray(rawProducts)) productResults.push({ entity_id: '', status: 'invalid', errors: ['changes.products doit être un tableau'] });
    const validProducts: ProductUpsert[] = [];
    for (const item of incomingProducts) {
      const parsed = productUpsertSchema.safeParse(item);
      if (!parsed.success) {
        const entityId = item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' ? item.id : '';
        productResults.push({
          entity_id: entityId,
          status: 'invalid',
          errors: parsed.error.issues.map((issue) =>
            `${issue.path.length ? issue.path.join('.') : 'payload'}: ${issue.message}`,
          ),
        });
      } else {
        validProducts.push(parsed.data);
      }
    }

    const rawStaff: unknown = dto.changes.staff ?? [];
    if (!Array.isArray(rawStaff)) {
      throw new BadRequestException('changes.staff doit être un tableau.');
    }
    const validStaff: StaffUpsert[] = rawStaff.map((item) => {
      const parsed = staffUpsertSchema.safeParse(item);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((issue) =>
          `${issue.path.length ? issue.path.join('.') : 'payload'}: ${issue.message}`,
        );
        throw new BadRequestException(errors.join('; '));
      }
      return parsed.data;
    });

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

      // Staff sync deliberately has no path to pin_hash, pin_algo, or auth_subject.
      // Those fields can only be changed by dedicated authenticated server routes.
      if (validStaff.length > 0) response.staff = [];
      for (const item of validStaff) {
        const displayName = item.displayName.trim();
        const role = item.role;
        const isActive = item.isActive ?? true;
        const deletedAt = item.deletedAt ?? null;
        const createdAt = item.createdAt ?? Date.now();

        const found = await tx.execute(sql`
          SELECT id, display_name, role, is_active, created_at, updated_at,
                 deleted_at, sync_seq, first_sync_seq
          FROM staff
          WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid
        `);
        let row = found.rows[0] as Record<string, unknown> | undefined;

        if (!row) {
          const inserted = await tx.execute(sql`
            INSERT INTO staff
              (id, tenant_id, display_name, role, is_active, created_at,
               updated_at, deleted_at, sync_seq, first_sync_seq)
            VALUES (
              ${item.id}::uuid, ${tenantId}::uuid, ${displayName}, ${role},
              ${isActive}, ${createdAt}, ${Date.now()}, ${deletedAt}, 0, 0
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id, sync_seq
          `);
          const insertedRow = inserted.rows[0] as Record<string, unknown> | undefined;
          if (insertedRow) {
            const status = deletedAt === null ? 'created' : 'deleted';
            if (status === 'created') response.applied.created += 1;
            else response.applied.deleted += 1;
            response.staff!.push({
              entity_id: item.id,
              status: 'applied',
              sync_seq: Number(insertedRow.sync_seq),
            });
            continue;
          }

          const retry = await tx.execute(sql`
            SELECT id, display_name, role, is_active, created_at, updated_at,
                   deleted_at, sync_seq, first_sync_seq
            FROM staff
            WHERE id = ${item.id}::uuid AND tenant_id = ${tenantId}::uuid
          `);
          row = retry.rows[0] as Record<string, unknown> | undefined;
          if (!row) {
            response.staff!.push({
              entity_id: item.id,
              status: 'conflict',
              errors: ['UUID déjà utilisé ou personnel inaccessible dans ce tenant'],
            });
            continue;
          }
        }

        const sameFields = (current: Record<string, unknown>) =>
          current.display_name === displayName &&
          current.role === role &&
          current.is_active === isActive &&
          (current.deleted_at === null ? null : Number(current.deleted_at)) === deletedAt;
        const currentSeq = Number(row.sync_seq);

        if (currentSeq !== item.lastKnownSyncSeq) {
          response.staff!.push(sameFields(row)
            ? { entity_id: item.id, status: 'idempotent', sync_seq: currentSeq }
            : { entity_id: item.id, status: 'conflict', sync_seq: currentSeq });
          continue;
        }

        if (row.deleted_at !== null && deletedAt === null) {
          response.staff!.push({
            entity_id: item.id,
            status: 'conflict',
            sync_seq: currentSeq,
            errors: ['Un membre du personnel supprimé ne peut pas être réactivé par sync'],
          });
          continue;
        }

        const removingActiveOwner =
          row.role === 'owner' &&
          row.is_active === true &&
          row.deleted_at === null &&
          (deletedAt !== null || !isActive || role !== 'owner');

        if (removingActiveOwner) {
          // Serialize owner-removal decisions per tenant to prevent two concurrent
          // pushes from each deleting a different "last" owner.
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':staff-owner-invariant'))
          `);
          const owners = await tx.execute(sql`
            SELECT COUNT(*)::int AS active_owners
            FROM staff
            WHERE tenant_id = ${tenantId}::uuid
              AND role = 'owner'
              AND is_active = true
              AND deleted_at IS NULL
              AND id <> ${item.id}::uuid
          `);
          const activeOwners = Number((owners.rows[0] as Record<string, unknown> | undefined)?.active_owners ?? 0);
          if (activeOwners < 1) {
            throw new ConflictException('Impossible de supprimer ou désactiver le dernier owner actif du tenant.');
          }
        }

        const updated = await tx.execute(sql`
          UPDATE staff
          SET display_name = ${displayName},
              role = ${role},
              is_active = ${isActive},
              deleted_at = ${deletedAt}
          WHERE id = ${item.id}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND sync_seq = ${item.lastKnownSyncSeq}
          RETURNING sync_seq
        `);
        const updatedRow = updated.rows[0] as Record<string, unknown> | undefined;
        if (!updatedRow) {
          response.staff!.push({ entity_id: item.id, status: 'conflict', sync_seq: currentSeq });
          continue;
        }
        if (deletedAt !== null) response.applied.deleted += 1;
        else response.applied.updated += 1;
        response.staff!.push({
          entity_id: item.id,
          status: 'applied',
          sync_seq: Number(updatedRow.sync_seq),
        });
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