import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';

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
 * Opens a transaction, sets the RLS tenant context, verifies that the tenant
 * already exists, and (optionally) takes the per-tenant advisory lock before
 * running the callback.
 *
 * set_config(..., true) is local to the transaction: it resets on COMMIT or
 * ROLLBACK. Non-UUID identifiers retain the legacy pass-through behavior;
 * valid UUIDs must resolve to an existing tenant before the callback runs.
 *
 * The existence check deliberately does not catch SQL errors: a failed
 * SELECT (for example, insufficient privilege) must propagate unchanged.
 */
export class TenantNotFoundError extends Error {
  readonly code = 'TENANT_NOT_FOUND' as const;

  constructor(readonly tenantId: string) {
    super(`Tenant introuvable: ${tenantId}`);
    this.name = 'TenantNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(
  db: NodePgDatabase<typeof schema>,
  tenantId: string,
  fn: (tx: TransactionClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
    );

    if (UUID_RE.test(tenantId)) {
      const existing = await tx.execute(
        sql`SELECT id FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1`,
      );
      if (existing.rows.length === 0) {
        throw new TenantNotFoundError(tenantId);
      }
    }

    // L'existence du tenant est vérifiée ici. Le contrôle de son statut
    // (pending, active, suspended) sera ajouté après merge de la migration 045.
    // Voir migration 045 et ticket de suivi.

    if (options.write) {
      // Must run before any INSERT/UPDATE that fires the sync_seq
      // trigger, and before any per-(agent, key) idempotency lock.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${TENANT_WRITE_LOCK_NS}::int, hashtext(${tenantId}::text))`,
      );
    }

    return fn(tx);
  }, { isolationLevel: 'read committed' });
}