import { z } from 'zod';

const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nullableText = (max: number) => z.string().max(max).nullable().optional();

/**
 * Client-authorized product fields for push.
 * Strict by design: server-owned columns (tenant_id, sync_seq, first_sync_seq,
 * updatedAt/updated_at) and unknown fields are rejected rather than ignored.
 */
export const productUpsertSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  sku: nullableText(64),
  barcode: nullableText(64),
  category: nullableText(80),
  price: nonNegativeSafeInteger,
  cost: nonNegativeSafeInteger.nullable().optional(),
  stockAlert: nonNegativeSafeInteger.optional(),
  isActive: z.boolean().optional(),
  // Offline-created records may retain the client creation timestamp.
  createdAt: nonNegativeSafeInteger.optional(),
  deletedAt: nonNegativeSafeInteger.nullable().optional(),
  lastKnownSyncSeq: nonNegativeSafeInteger,
}).strict();

export type ProductUpsert = z.infer<typeof productUpsertSchema>;

/** Server-to-client product projection; no tenant or trigger-owned sequence fields are exposed. */
export const productPullSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  sku: z.string().max(64).nullable(),
  barcode: z.string().max(64).nullable(),
  category: z.string().max(80).nullable(),
  price: nonNegativeSafeInteger,
  cost: nonNegativeSafeInteger.nullable(),
  stockAlert: nonNegativeSafeInteger,
  isActive: z.boolean(),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
  deletedAt: nonNegativeSafeInteger.nullable(),
  lastKnownSyncSeq: nonNegativeSafeInteger,
}).strict();

export type ProductPull = z.infer<typeof productPullSchema>;
