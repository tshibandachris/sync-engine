import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';

export type TransactionClient = Parameters<
  Parameters<NodePgDatabase<typeof schema>['transaction']>[0]
>[0];

/**
 * Wraps a read operation in a transaction that sets the tenant context for RLS.
 *
 * Uses set_config(..., true) which is local to the transaction: it resets on
 * COMMIT or ROLLBACK. If the tenant is missing or invalid, PostgreSQL raises
 * an error rather than silently returning cross-tenant data.
 *
 * Read-only companion to lockTenantWrites: use this in services that only read
 * tenant-scoped tables (pull, list conflicts, list attachments). Write paths
 * must use lockTenantWrites, which sets the same context and takes the lock.
 */
export async function withTenant<T>(
  db: NodePgDatabase<typeof schema>,
  tenantId: string,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
