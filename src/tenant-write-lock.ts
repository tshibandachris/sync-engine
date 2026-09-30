import { sql, type SQLWrapper } from 'drizzle-orm';

// Namespace constant. Must differ from:
//   - idempotency locks (pg_advisory_xact_lock(hashtext(agentId || ':' || key)))
//   - the test gate key in test/cursor-gaps.spec.ts (424242)
// The 2-arg variant and the 1-arg variant use disjoint int8 spaces.
const TENANT_WRITE_LOCK_NS = 7301;

export interface AdvisoryExecutor {
  execute: (q: SQLWrapper) => Promise<unknown>;
}

/**
 * Serialises all sync_seq-producing writes of one tenant until commit.
 * Must be the FIRST statement of the transaction, before any INSERT/UPDATE
 * that fires the sync_seq trigger, and before any per-(agent, key)
 * idempotency lock.
 *
 * Why: nextval('global_sync_seq') is not transactional. A transaction that
 * obtains seq N can commit after one that obtained seq N+1, leaving a gap
 * in the visible sequence. A client pulling in between advances past the
 * gap and never sees the earlier row.
 */
export async function lockTenantWrites(
  tx: AdvisoryExecutor,
  tenantId: string,
): Promise<void> {
  // Set the RLS context first, so the advisory-lock SELECT and every
  // following statement see only this tenant's rows.
  await tx.execute(
    sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${TENANT_WRITE_LOCK_NS}::int, hashtext(${tenantId}::text))`,
  );
}
