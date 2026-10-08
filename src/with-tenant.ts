import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';
import { ensureTenantRegistered, markTenantKnown } from './tenant-registry.js';

export type TransactionClient = Parameters<
  Parameters<NodePgDatabase<typeof schema>['transaction']>[0]
>[0];

// Advisory-lock namespace for per-tenant write serialization.
// Must differ from:
//   - idempotency locks (pg_advisory_xact_lock(hashtext(agentId || ':' || key)))
//   - attachment locks (ATTACHMENT_LOCK_NS in sync-attachment.service.ts)
//   - the test gate key in test/cursor-gaps.spec.ts (424242)
// The 2-arg variant and the 1-arg variant use disjoint int8 spaces.
const TENANT_WRITE_LOCK_NS = 7301;

export interface WithTenantOptions {
  /**
   * Serialise sync_seq-producing writes of one tenant until commit.
   *
   * Pass { write: true } if the callback performs any INSERT or UPDATE
   * that fires the sync_seq trigger. Without it, two concurrent
   * transactions can obtain seq N and N+1, commit in either order, and
   * leave a gap in the visible sequence. A client that pulls between the
   * two commits advances past the gap and never sees the earlier row.
   *
   * Read-only callers (SELECT, list, pull) must NOT pass it: the lock
   * serialises every write of the tenant and hurts throughput.
   */
  write?: boolean;
}

/**
 * Opens a transaction, sets the RLS tenant context, registers the tenant
 * in the registry (016) so maintenance can enumerate it later, and
 * (optionally) takes the per-tenant advisory lock, then runs the callback.
 *
 * set_config(..., true) is local to the transaction: it resets on
 * COMMIT or ROLLBACK. If the tenant id is malformed, PostgreSQL raises
 * rather than silently returning cross-tenant data.
 *
 * The registration is best-effort: a failure is logged and dropped, and
 * the tenant stays out of the local cache so the next call retries.
 * markTenantKnown runs only after COMMIT, so a rolled-back transaction
 * does not leave a phantom entry in the cache.
 */
export async function withTenant<T>(
  db: NodePgDatabase<typeof schema>,
  tenantId: string,
  fn: (tx: TransactionClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const state = { registered: false };

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
    );

    // Tenant registry (migration 016), so maintenance knows which tenants
    // to walk. Runs before the write lock: waiting on this INSERT must
    // not hold the advisory lock.
    state.registered = await ensureTenantRegistered(tx, tenantId);

    if (options.write) {
      // Must run before any INSERT/UPDATE that fires the sync_seq
      // trigger, and before any per-(agent, key) idempotency lock.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${TENANT_WRITE_LOCK_NS}::int, hashtext(${tenantId}::text))`,
      );
    }

    return fn(tx);
  });

  // Only after COMMIT: a rollback also rolled back the registration.
  if (state.registered) markTenantKnown(tenantId);
  return result;
}