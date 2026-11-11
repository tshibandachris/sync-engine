import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe('maintenance_purge_executor database boundary', () => {
  it('has no direct tenant-table write or read privileges', async () => {
    const result = await pg.maintenancePool.query<{
      current_user: string;
      can_read_tenants: boolean;
      can_insert_tenants: boolean;
      can_read_attachments: boolean;
      can_delete_attachments: boolean;
      can_delete_checkins: boolean;
      can_update_purge_state: boolean;
      is_sync_app_member: boolean;
    }>(`
      SELECT
        current_user,
        has_table_privilege(current_user, 'public.tenants', 'SELECT') AS can_read_tenants,
        has_table_privilege(current_user, 'public.tenants', 'INSERT') AS can_insert_tenants,
        has_table_privilege(current_user, 'public.attachments', 'SELECT') AS can_read_attachments,
        has_table_privilege(current_user, 'public.attachments', 'DELETE') AS can_delete_attachments,
        has_table_privilege(current_user, 'public.check_ins', 'DELETE') AS can_delete_checkins,
        has_table_privilege(current_user, 'public.sync_purge_state', 'UPDATE') AS can_update_purge_state,
        pg_has_role(current_user, 'sync_app', 'MEMBER') AS is_sync_app_member
    `);
    expect(result.rows[0]).toMatchObject({
      current_user: 'maintenance_test',
      can_read_tenants: true,
      can_insert_tenants: false,
      can_read_attachments: false,
      can_delete_attachments: false,
      can_delete_checkins: false,
      can_update_purge_state: false,
      is_sync_app_member: false,
    });
  });

  it('does not grant the purge functions to the API login', async () => {
    const result = await pg.appPool.query<{
      tombstones: boolean;
      pending: boolean;
      orphan_listing: boolean;
      sync_logs: boolean;
      nonces: boolean;
    }>(`
      SELECT
        has_function_privilege(current_user, 'public.purge_tenant_tombstones(uuid,integer)', 'EXECUTE') AS tombstones,
        has_function_privilege(current_user, 'public.purge_tenant_pending_attachments(uuid,integer)', 'EXECUTE') AS pending,
        has_function_privilege(current_user, 'public.list_tenant_attachment_object_keys(uuid)', 'EXECUTE') AS orphan_listing,
        has_function_privilege(current_user, 'public.purge_tenant_sync_logs(uuid,integer)', 'EXECUTE') AS sync_logs,
        has_function_privilege(current_user, 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE') AS nonces
    `);
    expect(result.rows[0]).toEqual({
      tombstones: false,
      pending: false,
      orphan_listing: false,
      sync_logs: false,
      nonces: false,
    });
  });

  it('can execute the approved purge functions and cannot execute device administration', async () => {
    const result = await pg.maintenancePool.query<{
      tombstones: boolean;
      pending: boolean;
      orphan_listing: boolean;
      sync_logs: boolean;
      nonces: boolean;
      device_approval: boolean;
    }>(`
      SELECT
        has_function_privilege(current_user, 'public.purge_tenant_tombstones(uuid,integer)', 'EXECUTE') AS tombstones,
        has_function_privilege(current_user, 'public.purge_tenant_pending_attachments(uuid,integer)', 'EXECUTE') AS pending,
        has_function_privilege(current_user, 'public.list_tenant_attachment_object_keys(uuid)', 'EXECUTE') AS orphan_listing,
        has_function_privilege(current_user, 'public.purge_tenant_sync_logs(uuid,integer)', 'EXECUTE') AS sync_logs,
        has_function_privilege(current_user, 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE') AS nonces,
        has_function_privilege(current_user, 'public.transition_device_approval(uuid,uuid,uuid,text,character varying)', 'EXECUTE') AS device_approval
    `);
    expect(result.rows[0]).toEqual({
      tombstones: true,
      pending: true,
      orphan_listing: true,
      sync_logs: true,
      nonces: true,
      device_approval: false,
    });
  });
});
