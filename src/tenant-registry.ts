import { sql } from 'drizzle-orm';
import type { TransactionClient } from './with-tenant.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tenants dont l'inscription est connue de CE processus. Rempli seulement après un COMMIT :
// une transaction annulée annule aussi l'inscription, le tenant doit alors être réessayé.
const known = new Set<string>();

export function markTenantKnown(tenantId: string): void {
  known.add(tenantId);
}

/**
 * Enregistre le tenant dans `tenants` s'il n'est pas déjà connu de ce processus.
 * Retourne true si l'inscription a eu lieu dans la transaction courante (à confirmer par
 * markTenantKnown après le commit).
 *
 * L'INSERT est isolé dans un savepoint : un échec (droit retiré, migration 016 pas encore
 * appliquée) est journalisé mais ne doit jamais faire échouer la requête métier.
 */
export async function ensureTenantRegistered(tx: TransactionClient, tenantId: string): Promise<boolean> {
  if (known.has(tenantId) || !UUID_RE.test(tenantId)) return false;
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(
        sql`INSERT INTO tenants (id, first_seen_at)
            VALUES (${tenantId}::uuid, ${Date.now()}::bigint)
            ON CONFLICT (id) DO NOTHING`,
      );
    });
    return true;
  } catch (err) {
    console.error('[tenants] registration failed:', err);
    return false;
  }
}
