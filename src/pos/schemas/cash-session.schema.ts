import { z } from 'zod';

const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const allowed = new Set([
  'id', 'staffId', 'terminalLabel', 'openedAt', 'openingAmount',
  'status', 'notes', 'createdAt', 'lastKnownSyncSeq',
]);

/**
 * Sync may create open sessions and edit notes only. Closing is a server-owned
 * transition handled by POST /cash-sessions/:id/close.
 */
export const cashSessionPushSchema = z.unknown().transform((input, ctx) => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.addIssue({ code: 'custom', message: 'cash session payload must be an object' });
    return z.NEVER;
  }

  const record = input as Record<string, unknown>;
  let invalid = false;
  for (const key of Object.keys(record)) {
    if (['closedAt', 'closingAmount', 'expectedAmount', 'difference',
      'closed_at', 'closing_amount', 'expected_amount'].includes(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'La clôture et les montants de clôture doivent passer par POST /cash-sessions/:id/close.',
      });
      invalid = true;
    } else if (!allowed.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Unknown cash session field "${key}" is not allowed through sync`,
      });
      invalid = true;
    }
  }

  const parsed = z.object({
    id: z.string().uuid(),
    staffId: z.string().uuid().optional(),
    terminalLabel: z.string().trim().max(40).nullable().optional(),
    openedAt: nonNegativeSafeInteger.optional(),
    openingAmount: nonNegativeSafeInteger.optional(),
    status: z.enum(['open', 'closed']).optional(),
    notes: z.string().max(500).nullable().optional(),
    createdAt: nonNegativeSafeInteger.optional(),
    lastKnownSyncSeq: nonNegativeSafeInteger,
  }).safeParse(record);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
    invalid = true;
  }
  if (invalid || !parsed.success) return z.NEVER;
  if (parsed.data.status === 'closed') {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Une session ne peut pas être créée ou clôturée via la synchronisation.',
    });
    return z.NEVER;
  }
  if (parsed.data.lastKnownSyncSeq === 0 &&
      (parsed.data.staffId === undefined || parsed.data.openedAt === undefined ||
       parsed.data.openingAmount === undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Une nouvelle session ouverte exige staffId, openedAt et openingAmount.',
    });
    return z.NEVER;
  }
  if (parsed.data.openingAmount !== undefined && parsed.data.openingAmount < 0) {
    ctx.addIssue({ code: 'custom', path: ['openingAmount'], message: 'openingAmount doit être positif ou nul' });
    return z.NEVER;
  }
  return parsed.data;
});

export type CashSessionPush = z.infer<typeof cashSessionPushSchema>;
