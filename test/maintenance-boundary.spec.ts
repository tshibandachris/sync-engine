import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';

let pg: TestPostgres;

beforeAll(async () => { pg = await startTestPostgres(); }, 180_000);
afterAll(async () => { await pg?.stop(); }, 30_000);

describe('maintenance privilege boundary', () => {
  it('denies EXECUTE to sync_app and PUBLIC for every application-schema purge_* function', async () => {
    const result = await pg.pool.query(
      "SELECT p.oid::regprocedure::text AS function_name, " +
      "CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee " +
      "FROM pg_catalog.pg_proc p " +
      "CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl " +
      "LEFT JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace " +
      "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') " +
      "AND left(p.proname, 6) = 'purge_' " +
      "AND acl.privilege_type = 'EXECUTE' " +
      "AND (acl.grantee = 0 OR acl.grantee = 'sync_app'::regrole " +
      "OR pg_catalog.has_function_privilege('sync_app', p.oid, 'EXECUTE')) " +
      "ORDER BY function_name, grantee"
    );
    expect(result.rows).toEqual([]);
  });

  it('returns SQLSTATE 42501 when sync_app invokes nonce, tombstone, or sync-log purge', async () => {
    const tenantId = randomUUID();
    const client = await pg.appPool.connect();
    const calls: Array<[string, unknown[]]> = [
      ['SELECT public.purge_expired_device_proof_nonces($1::uuid, 1)', [tenantId]],
      ['SELECT public.purge_tenant_tombstones($1::uuid, 30)', [tenantId]],
      ['SELECT public.purge_tenant_sync_logs($1::uuid, 30)', [tenantId]],
      ['SELECT public.purge_sync_tables(7, 30)', []],
    ];
    try {
      for (const [statement, values] of calls) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        await expect(client.query(statement, values)).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
  });

  it('allows maintenance_login to invoke all three purge functions through maintenanceDb', async () => {
    const tenantId = randomUUID();
    const service = new SyncMaintenanceService(pg.maintenanceDb);
    await service.purgeExpiredDeviceProofNonces(tenantId, 1);
    await service.purgeTenantTombstones(tenantId, 30);
    await service.purgeSyncLogs(tenantId, 30);
    await service.purge(tenantId, { ttlIdempotencyDays: 7, ttlConflictsDays: 30 });
  });

  it('cannot INSERT, UPDATE, or DELETE directly in business tables', async () => {
    const client = await pg.maintenancePool.connect();
    const tables = [
      'attachments', 'check_ins', 'missions', 'sites', 'sync_logs',
      'sync_conflicts', 'sync_idempotency_keys', 'device_proof_nonces',
    ];
    try {
      const grants = await client.query(
        "SELECT c.relname FROM pg_catalog.pg_class c " +
        "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND (" +
        "pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT') OR " +
        "pg_catalog.has_table_privilege(current_user, c.oid, 'UPDATE') OR " +
        "pg_catalog.has_table_privilege(current_user, c.oid, 'DELETE') OR " +
        "pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT') OR " +
        "pg_catalog.has_any_column_privilege(current_user, c.oid, 'UPDATE') OR " +
        "pg_catalog.has_any_column_privilege(current_user, c.oid, 'DELETE'))"
      );
      expect(grants.rows).toEqual([]);
      for (const table of tables) {
        await expect(client.query('INSERT INTO public.' + table + ' DEFAULT VALUES'))
          .rejects.toMatchObject({ code: '42501' });
        await expect(client.query('UPDATE public.' + table + ' SET tenant_id = tenant_id WHERE false'))
          .rejects.toMatchObject({ code: '42501' });
        await expect(client.query('DELETE FROM public.' + table + ' WHERE false'))
          .rejects.toMatchObject({ code: '42501' });
      }
    } finally { client.release(); }
  });
});
