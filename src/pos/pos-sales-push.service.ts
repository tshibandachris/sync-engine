import { BadRequestException, ConflictException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { withTenant } from '../with-tenant.js';
import { salePushSchema } from './schemas/sale-push.schema.js';

export type SalePushResult = {
  id: string | null;
  status: 'applied' | 'idempotent' | 'conflict' | 'invalid';
  reason: string | null;
};
type Db = NodePgDatabase<typeof schema>;

export class PosSalesPushService {
  constructor(private readonly db: Db) {}

  async push(tenantId: string, payload: unknown): Promise<SalePushResult[]> {
    if (!Array.isArray(payload)) throw new BadRequestException('changes.sales must be an array');
    const results: SalePushResult[] = [];
    const touched = new Set<string>();

    for (const raw of payload) {
      const parsed = salePushSchema.safeParse(raw);
      const id = raw && typeof raw === 'object' && 'id' in raw && typeof (raw as any).id === 'string' ? (raw as any).id : null;
      if (!parsed.success) {
        results.push({ id, status: 'invalid', reason: parsed.error.issues.map(x => x.message).join('; ') });
        continue;
      }
      const s = parsed.data;
      try {
        const status = await withTenant(this.db, tenantId, async tx => {
          const prior = await tx.execute(sql`SELECT * FROM sales WHERE tenant_id=${tenantId}::uuid AND id=${s.id}::uuid FOR UPDATE`);
          if (prior.rows.length) {
            const row = prior.rows[0] as any;
            const same = row.cash_session_id === s.cash_session_id && row.staff_id === s.staff_id &&
              row.sale_number === s.sale_number && Number(row.total) === s.total &&
              row.payment_method === s.payment_method && Number(row.cash_amount) === s.cash_amount &&
              Number(row.mobile_amount) === s.mobile_amount && (row.mobile_msisdn ?? null) === (s.mobile_msisdn ?? null) &&
              (row.mobile_reference ?? null) === (s.mobile_reference ?? null) && (row.customer_note ?? null) === (s.customer_note ?? null) &&
              Boolean(row.is_void) === s.is_void && (row.voided_sale_id ?? null) === (s.voided_sale_id ?? null) &&
              (row.void_reason ?? null) === (s.void_reason ?? null) &&
              Number(row.created_at) === s.created_at;
            if (!same) throw new ConflictException('sale UUID already exists with different content');
            const lines = await tx.execute(sql`SELECT id, product_id, product_name, product_sku, quantity, unit_price, subtotal, created_at, updated_at FROM sale_lines WHERE tenant_id=${tenantId}::uuid AND sale_id=${s.id}::uuid`);
            const lineMatch = lines.rows.length === s.lines.length && s.lines.every(l =>
              (lines.rows as any[]).some(r => r.id === l.id && r.product_id === l.product_id &&
                r.product_name === l.product_name && (r.product_sku ?? null) === (l.product_sku ?? null) &&
                Number(r.quantity) === l.quantity && Number(r.unit_price) === l.unit_price &&
                Number(r.subtotal) === l.subtotal && Number(r.created_at) === l.created_at));
            const movements = await tx.execute(sql`SELECT id, product_id, movement_type, quantity_delta, reference_id, reference_type, unit_cost, notes, created_at, updated_at, created_by FROM stock_movements WHERE tenant_id=${tenantId}::uuid AND reference_type='sale' AND reference_id=${s.id}::uuid`);
            const movementMatch = movements.rows.length === s.stock_movements.length && s.stock_movements.every(m =>
              (movements.rows as any[]).some(r => r.id === m.id && r.product_id === m.product_id &&
                r.movement_type === m.movement_type && Number(r.quantity_delta) === m.quantity_delta &&
                r.reference_id === m.reference_id && r.reference_type === m.reference_type &&
                (r.unit_cost == null ? null : Number(r.unit_cost)) === (m.unit_cost ?? null) &&
                (r.notes ?? null) === (m.notes ?? null) && Number(r.created_at) === m.created_at &&
                (r.created_by ?? null) === (m.created_by ?? null)));
            if (!lineMatch || !movementMatch) throw new ConflictException('sale UUID already exists with different content');
            return 'idempotent' as const;
          }

          const session = await tx.execute(sql`SELECT id FROM cash_sessions WHERE tenant_id=${tenantId}::uuid AND id=${s.cash_session_id}::uuid`);
          if (!session.rows.length) throw new BadRequestException('cash session not found');
          if (s.is_void) {
            const orig = await tx.execute(sql`SELECT total,cash_amount,mobile_amount,is_void FROM sales WHERE tenant_id=${tenantId}::uuid AND id=${s.voided_sale_id}::uuid`);
            if (!orig.rows.length) throw new BadRequestException('original sale not found');
            const o = orig.rows[0] as any;
            const originalLines = await tx.execute(sql`SELECT product_id,quantity FROM sale_lines WHERE tenant_id=${tenantId}::uuid AND sale_id=${s.voided_sale_id}::uuid`);
            if (Boolean(o.is_void) || s.total !== -Number(o.total) || s.cash_amount !== -Number(o.cash_amount) ||
              s.mobile_amount !== -Number(o.mobile_amount) || originalLines.rows.length !== s.lines.length ||
              !s.lines.every(l => (originalLines.rows as any[]).some(r => r.product_id === l.product_id && Number(r.quantity) === -l.quantity))) {
              throw new BadRequestException('void amounts do not mirror original sale');
            }
          }
          await tx.execute(sql`INSERT INTO sales
            (id,tenant_id,cash_session_id,staff_id,sale_number,total,payment_method,cash_amount,mobile_amount,
             mobile_msisdn,mobile_reference,customer_note,is_void,voided_sale_id,void_reason,created_at,updated_at,sync_seq,first_sync_seq)
            VALUES (${s.id}::uuid,${tenantId}::uuid,${s.cash_session_id}::uuid,${s.staff_id}::uuid,${s.sale_number},
             ${s.total},${s.payment_method},${s.cash_amount},${s.mobile_amount},${s.mobile_msisdn ?? null},
             ${s.mobile_reference ?? null},${s.customer_note ?? null},${s.is_void},${s.voided_sale_id ?? null}::uuid,
             ${s.void_reason ?? null},${s.created_at},${s.updated_at},0,0)`);
          for (const l of s.lines) await tx.execute(sql`INSERT INTO sale_lines
            (id,tenant_id,sale_id,product_id,product_name,product_sku,quantity,unit_price,subtotal,created_at,updated_at,sync_seq,first_sync_seq)
            VALUES (${l.id}::uuid,${tenantId}::uuid,${s.id}::uuid,${l.product_id}::uuid,${l.product_name},
            ${l.product_sku ?? null},${l.quantity},${l.unit_price},${l.subtotal},${l.created_at},${l.updated_at},0,0)`);
          for (const m of s.stock_movements) {
            if (m.reference_id !== s.id || m.reference_type !== 'sale') throw new BadRequestException('stock movement must reference its sale');
            await tx.execute(sql`INSERT INTO stock_movements
              (id,tenant_id,product_id,movement_type,quantity_delta,reference_id,reference_type,unit_cost,notes,created_at,updated_at,created_by,sync_seq,first_sync_seq)
              VALUES (${m.id}::uuid,${tenantId}::uuid,${m.product_id}::uuid,${m.movement_type},${m.quantity_delta},
              ${m.reference_id}::uuid,${m.reference_type},${m.unit_cost ?? null},${m.notes ?? null},${m.created_at},
              ${m.updated_at},${m.created_by ?? null}::uuid,0,0)`);
          }
          return 'applied' as const;
        }, { write: true });
        results.push({ id: s.id, status, reason: null });
        touched.add(s.cash_session_id);
      } catch (e: any) {
        const cause = e?.cause ?? e;
        const status = e instanceof ConflictException || cause?.code === '23505' ? 'conflict' : 'invalid';
        const reason = cause?.constraint === 'idx_sales_void_unique' ? 'sale already voided' :
          e instanceof Error ? e.message : 'sale could not be applied';
        results.push({ id: s.id, status, reason });
      }
    }

    for (const sessionId of touched) {
      try {
        await withTenant(this.db, tenantId, async tx => {
          await tx.execute(sql`UPDATE cash_sessions cs SET
            reconciled_expected_amount = cs.opening_amount + COALESCE((SELECT SUM(s.cash_amount)::integer FROM sales s WHERE s.tenant_id=cs.tenant_id AND s.cash_session_id=cs.id),0),
            reconciled_difference = cs.closing_amount - (cs.opening_amount + COALESCE((SELECT SUM(s.cash_amount)::integer FROM sales s WHERE s.tenant_id=cs.tenant_id AND s.cash_session_id=cs.id),0)),
            reconciled_at = (extract(epoch FROM clock_timestamp())*1000)::bigint,
            reconciliation_alert = (cs.closing_amount <> cs.opening_amount + COALESCE((SELECT SUM(s.cash_amount)::integer FROM sales s WHERE s.tenant_id=cs.tenant_id AND s.cash_session_id=cs.id),0)),
            reconciliation_alert_reason = CASE WHEN cs.closing_amount <> cs.opening_amount + COALESCE((SELECT SUM(s.cash_amount)::integer FROM sales s WHERE s.tenant_id=cs.tenant_id AND s.cash_session_id=cs.id),0) THEN 'amount_mismatch' ELSE NULL END
            WHERE cs.tenant_id=${tenantId}::uuid AND cs.id=${sessionId}::uuid AND cs.status='closed'`);
        }, { write: true });
      } catch { /* The periodic job retries derived reconciliation; committed sales remain valid. */ }
    }
    return results;
  }
}
