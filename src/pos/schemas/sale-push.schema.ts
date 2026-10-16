import { z } from 'zod';

const id = z.string().uuid();
const integer = z.number().int().safe();
const nonNegative = integer.min(0);

export const saleLinePushSchema = z.object({
  id, product_id: id, product_name: z.string().min(1).max(200),
  product_sku: z.string().max(64).nullable().optional(),
  quantity: integer.refine((v) => v !== 0, 'quantity must not be zero'),
  unit_price: nonNegative, subtotal: integer,
  created_at: nonNegative, updated_at: nonNegative,
}).strict();

export const stockMovementPushSchema = z.object({
  id, product_id: id,
  movement_type: z.enum(['sale', 'void']),
  quantity_delta: integer.refine((v) => v !== 0, 'quantity_delta must not be zero'),
  reference_id: id, reference_type: z.string().min(1).max(30),
  unit_cost: nonNegative.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  created_at: nonNegative, updated_at: nonNegative,
  created_by: id.nullable().optional(),
}).strict();

export const salePushSchema = z.object({
  id, cash_session_id: id, staff_id: id, sale_number: z.string().min(1).max(32),
  total: integer, payment_method: z.enum(['cash', 'mobile_money', 'mixed']),
  cash_amount: integer, mobile_amount: integer,
  mobile_msisdn: z.string().max(20).nullable().optional(),
  mobile_reference: z.string().max(64).nullable().optional(),
  customer_note: z.string().max(200).nullable().optional(),
  is_void: z.boolean().default(false),
  voided_sale_id: id.nullable().optional(),
  void_reason: z.string().max(200).nullable().optional(),
  created_at: nonNegative, updated_at: nonNegative,
  lines: z.array(saleLinePushSchema).min(1),
  stock_movements: z.array(stockMovementPushSchema),
}).strict().superRefine((sale, ctx) => {
  if (sale.total !== sale.cash_amount + sale.mobile_amount) {
    ctx.addIssue({ code: 'custom', message: 'total must equal cash_amount + mobile_amount' });
  }
  if (!sale.is_void && (sale.total < 0 || sale.cash_amount < 0 || sale.mobile_amount < 0)) {
    ctx.addIssue({ code: 'custom', message: 'normal sale amounts must be non-negative' });
  }
  if (sale.is_void && (!sale.voided_sale_id || !sale.void_reason ||
      sale.total > 0 || sale.cash_amount > 0 || sale.mobile_amount > 0)) {
    ctx.addIssue({ code: 'custom', message: 'void requires a reference, reason, and non-positive amounts' });
  }
  if (!sale.is_void && (sale.voided_sale_id != null || sale.void_reason != null)) {
    ctx.addIssue({ code: 'custom', message: 'normal sale cannot reference a void' });
  }
  if (sale.lines.reduce((sum, line) => sum + line.subtotal, 0) !== sale.total) {
    ctx.addIssue({ code: 'custom', message: 'sale line subtotals must sum to total' });
  }
  for (const line of sale.lines) {
    if (line.subtotal !== line.quantity * line.unit_price) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'line subtotal mismatch' });
    }
  }
});

export const salesBatchPushSchema = z.array(z.unknown());
export type SalePush = z.infer<typeof salePushSchema>;
