import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import fs from 'node:fs';
import path from 'node:path';
import { assertNonPrivilegedRole } from '../src/role-guard.js';

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
      current_user: 'maintenance_login',
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
      sync_tables: boolean;
    }>(`
      SELECT
        has_function_privilege(current_user, 'public.purge_tenant_tombstones(uuid,integer)', 'EXECUTE') AS tombstones,
        has_function_privilege(current_user, 'public.purge_tenant_pending_attachments(uuid,integer)', 'EXECUTE') AS pending,
        has_function_privilege(current_user, 'public.list_tenant_attachment_object_keys(uuid)', 'EXECUTE') AS orphan_listing,
        has_function_privilege(current_user, 'public.purge_tenant_sync_logs(uuid,integer)', 'EXECUTE') AS sync_logs,
        has_function_privilege(current_user, 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE') AS nonces,
        has_function_privilege(current_user, 'public.purge_sync_tables(integer,integer)', 'EXECUTE') AS sync_tables
    `);
    expect(result.rows[0]).toEqual({
      tombstones: false,
      pending: false,
      orphan_listing: false,
      sync_logs: false,
      nonces: false,
      sync_tables: false,
    });
  });

  it('keeps sync-log SECURITY DEFINER under a non-login owner subject to RLS', async () => {
    const result = await pg.pool.query(`
      SELECT
        pg_catalog.pg_get_userbyid(p.proowner) AS function_owner,
        r.rolcanlogin,
        r.rolsuper,
        r.rolbypassrls,
        r.rolinherit,
        pg_catalog.has_table_privilege(r.rolname, 'public.sync_logs', 'SELECT') AS can_read_logs,
        pg_catalog.has_table_privilege(r.rolname, 'public.sync_logs', 'DELETE') AS can_delete_logs,
        pg_catalog.pg_has_role(r.rolname, 'sync_app', 'MEMBER') AS is_sync_app_member,
        EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = r.oid) AS owns_tables
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.rolname = 'maintenance_function_owner'
      WHERE p.oid = 'public.purge_tenant_sync_logs(uuid,integer)'::regprocedure
    `);
    expect(result.rows[0]).toMatchObject({
      function_owner: 'maintenance_function_owner',
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      can_read_logs: true,
      can_delete_logs: true,
      is_sync_app_member: false,
      owns_tables: false,
    });
  });

  it('can execute the approved purge functions and cannot execute device administration', async () => {
    const result = await pg.maintenancePool.query<{
      tombstones: boolean;
      pending: boolean;
      orphan_listing: boolean;
      sync_logs: boolean;
      nonces: boolean;
      sync_tables: boolean;
      device_approval: boolean;
    }>(`
      SELECT
        has_function_privilege(current_user, 'public.purge_tenant_tombstones(uuid,integer)', 'EXECUTE') AS tombstones,
        has_function_privilege(current_user, 'public.purge_tenant_pending_attachments(uuid,integer)', 'EXECUTE') AS pending,
        has_function_privilege(current_user, 'public.list_tenant_attachment_object_keys(uuid)', 'EXECUTE') AS orphan_listing,
        has_function_privilege(current_user, 'public.purge_tenant_sync_logs(uuid,integer)', 'EXECUTE') AS sync_logs,
        has_function_privilege(current_user, 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE') AS nonces,
        has_function_privilege(current_user, 'public.purge_sync_tables(integer,integer)', 'EXECUTE') AS sync_tables,
        has_function_privilege(current_user, 'public.transition_device_approval(uuid,uuid,uuid,text,character varying)', 'EXECUTE') AS device_approval
    `);
    expect(result.rows[0]).toEqual({
      tombstones: true,
      pending: true,
      orphan_listing: true,
      sync_logs: true,
      nonces: true,
      sync_tables: true,
      device_approval: false,
    });
  });
});

describe('maintenance role hardening migration 042', () => {
  const migrationPath = path.resolve('migrations/042_maintenance_function_owner_hardening.sql');

  it('keeps the nonce function owner non-login, non-privileged and without role memberships', async () => {
    const result = await pg.pool.query(`
      SELECT
        r.rolcanlogin,
        r.rolsuper,
        r.rolcreatedb,
        r.rolcreaterole,
        r.rolreplication,
        r.rolbypassrls,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members m
          WHERE m.member = r.oid OR m.roleid = r.oid
        ) AS has_role_memberships
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = 'device_proof_maintenance_function_owner'
    `);
    expect(result.rows[0]).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      has_role_memberships: false,
    });
  });

  it('rejects a pre-existing nonce function owner that can LOGIN', async () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    await pg.pool.query('ALTER ROLE device_proof_maintenance_function_owner LOGIN');
    try {
      await expect(pg.pool.query(migration)).rejects.toThrow(/SECURITY_MIGRATION_FAILED/);
    } finally {
      await pg.pool.query('ALTER ROLE device_proof_maintenance_function_owner NOLOGIN');
    }
  });

  it('rejects a pre-existing nonce function owner that is a member of a pg_* role', async () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    await pg.pool.query('GRANT pg_monitor TO device_proof_maintenance_function_owner');
    try {
      await expect(pg.pool.query(migration)).rejects.toThrow(/SECURITY_MIGRATION_FAILED/);
    } finally {
      await pg.pool.query('REVOKE pg_monitor FROM device_proof_maintenance_function_owner');
    }
  });

  it('rejects another role being a member of the nonce function owner', async () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    await pg.pool.query('GRANT device_proof_maintenance_function_owner TO maintenance_login');
    try {
      await expect(pg.pool.query(migration)).rejects.toThrow(/SECURITY_MIGRATION_FAILED/);
    } finally {
      await pg.pool.query('REVOKE device_proof_maintenance_function_owner FROM maintenance_login');
    }
  });
});

describe('maintenance_login runtime membership boundary', () => {
  it('rejects membership in a predefined pg_* role even when the login is not privileged itself', async () => {
    await pg.pool.query('GRANT pg_read_all_data TO maintenance_login');
    try {
      await expect(assertNonPrivilegedRole(pg.maintenancePool)).rejects.toThrow(/appartenance/i);
    } finally {
      await pg.pool.query('REVOKE pg_read_all_data FROM maintenance_login');
    }
  });

  it('accepts only the maintenance_purge_executor membership', async () => {
    await expect(assertNonPrivilegedRole(pg.maintenancePool)).resolves.toBeUndefined();
    const result = await pg.pool.query(`
      SELECT count(*)::integer AS membership_count,
             bool_and(
               r.rolname = 'maintenance_purge_executor'
               AND NOT m.admin_option
               AND m.inherit_option
               AND NOT m.set_option
             ) AS allowed_membership_only
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = m.member
      JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
      WHERE member_role.rolname = 'maintenance_login'
    `);
    expect(result.rows[0]).toEqual({ membership_count: 1, allowed_membership_only: true });
  });
});
