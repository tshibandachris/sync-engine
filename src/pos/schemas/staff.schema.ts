import { z } from 'zod';

const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const staffFieldsSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(['owner', 'manager', 'cashier']),
  isActive: z.boolean().optional(),
  createdAt: nonNegativeSafeInteger.optional(),
  deletedAt: nonNegativeSafeInteger.nullable().optional(),
  lastKnownSyncSeq: nonNegativeSafeInteger,
});

/**
 * Only business fields may cross the sync channel. In particular, PIN material
 * and authentication identities are rejected explicitly instead of being
 * silently stripped or accepted by a permissive object schema.
 */
export const staffUpsertSchema = z.unknown().transform((input, ctx) => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.addIssue({ code: 'custom', message: 'staff payload must be an object' });
    return z.NEVER;
  }

  const record = input as Record<string, unknown>;
  const allowed = new Set([
    'id', 'displayName', 'role', 'isActive', 'createdAt', 'deletedAt', 'lastKnownSyncSeq',
  ]);
  let invalid = false;

  for (const key of Object.keys(record)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (normalized.startsWith('pin') || normalized === 'plaintextpin') {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'PIN cannot be set through sync. Use POST /staff/:id/pin',
      });
      invalid = true;
    } else if (!allowed.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Unknown staff field "${key}" is not allowed through sync`,
      });
      invalid = true;
    }
  }

  const parsed = staffFieldsSchema.safeParse(record);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
    invalid = true;
  }

  if (invalid || !parsed.success) return z.NEVER;
  return parsed.data;
});

export type StaffUpsert = z.infer<typeof staffUpsertSchema>;
