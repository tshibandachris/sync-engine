import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe('registre métier des tenants (migration 045)', () => {
  it('le backfill conserve exactement le nombre de tenants préexistants et les active tous', async () => {
    const r = await pg.pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status IS NULL OR status NOT IN ('pending', 'active', 'suspended'))::int AS invalid
       FROM tenants`,
    );
    expect(r.rows[0]).toEqual({
      total: pg.tenantCountBefore045,
      active: pg.tenantCountBefore045,
      invalid: 0,
    });
    const fixtures = await pg.pool.query(
      `SELECT count(*)::int AS n FROM tenants
       WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [['10000000-0000-4000-8000-000000000045', '10000000-0000-4000-8000-000000000046']],
    );
    expect(fixtures.rows[0].n).toBe(2);
  });

  it('sync_app conserve SELECT sans pouvoir INSERT, UPDATE ou DELETE', async () => {
    const id = randomUUID();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)',
      [id, Date.now()],
    );

    const read = await pg.appPool.query('SELECT id, status FROM tenants WHERE id = $1', [id]);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0].status).toBe('pending');

    await expect(
      pg.appPool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)', [randomUUID(), Date.now()]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pg.appPool.query('UPDATE tenants SET status = \'active\' WHERE id = $1', [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(pg.appPool.query('DELETE FROM tenants WHERE id = $1', [id])).rejects.toThrow(/permission denied/);
  });

  it('sync_app possède exactement SELECT sur tenants', async () => {
    const r = await pg.pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'sync_app' AND table_schema = 'public' AND table_name = 'tenants'
       ORDER BY privilege_type`,
    );
    expect(r.rows.map((row: { privilege_type: string }) => row.privilege_type)).toEqual(['SELECT']);
  });

  it('les deux rôles de provisioning sont NOLOGIN et sans privilèges élevés', async () => {
    const r = await pg.pool.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
              rolinherit, rolreplication, rolbypassrls
       FROM pg_catalog.pg_roles
       WHERE rolname IN ('tenant_provisioning_function_owner', 'tenant_provisioning_executor')
       ORDER BY rolname`,
    );
    expect(r.rows).toHaveLength(2);
    for (const role of r.rows) {
      expect(role.rolcanlogin).toBe(false);
      expect(role.rolsuper).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      expect(role.rolinherit).toBe(false);
      expect(role.rolreplication).toBe(false);
      expect(role.rolbypassrls).toBe(false);
    }
  });

  it('le rôle executor ne possède aucun droit direct de modification sur tenants', async () => {
    const r = await pg.pool.query(
      `SELECT
         has_table_privilege('tenant_provisioning_executor', 'public.tenants', 'SELECT') AS can_select,
         has_table_privilege('tenant_provisioning_executor', 'public.tenants', 'INSERT') AS can_insert,
         has_table_privilege('tenant_provisioning_executor', 'public.tenants', 'UPDATE') AS can_update,
         has_table_privilege('tenant_provisioning_executor', 'public.tenants', 'DELETE') AS can_delete`,
    );
    expect(r.rows[0]).toEqual({ can_select: false, can_insert: false, can_update: false, can_delete: false });
  });

  it('les statuts autorisés et la valeur par défaut pending sont appliqués', async () => {
    const id = randomUUID();
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)', [id, Date.now()]);
    const r = await pg.pool.query('SELECT status FROM tenants WHERE id = $1', [id]);
    expect(r.rows[0].status).toBe('pending');

    await expect(
      pg.pool.query('UPDATE tenants SET status = \'unknown\' WHERE id = $1', [id]),
    ).rejects.toThrow(/tenants_status_check/);
  });

  it('la contrainte de suspension impose des champs cohérents', async () => {
    const id = randomUUID();
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)', [id, Date.now()]);

    await expect(
      pg.pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [id]),
    ).rejects.toThrow(/tenants_suspension_state_check/);
    await expect(
      pg.pool.query(
        "UPDATE tenants SET status = 'suspended', suspended_at = now(), suspended_reason = '   ' WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/tenants_suspension_state_check/);
    await expect(
      pg.pool.query(
        "UPDATE tenants SET status = 'active', suspended_at = now(), suspended_reason = 'reason' WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/tenants_suspension_state_check/);

    await pg.pool.query(
      "UPDATE tenants SET status = 'suspended', suspended_at = now(), suspended_reason = 'administrative review' WHERE id = $1",
      [id],
    );
    await pg.pool.query(
      "UPDATE tenants SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = $1",
      [id],
    );
    const r = await pg.pool.query(
      'SELECT status, suspended_at, suspended_reason FROM tenants WHERE id = $1',
      [id],
    );
    expect(r.rows[0]).toEqual({ status: 'active', suspended_at: null, suspended_reason: null });
  });

  it('PUBLIC ne possède aucun privilège et tenants reste volontairement sans RLS', async () => {
    const r = await pg.pool.query(
      `SELECT relacl::text AS acl, relrowsecurity FROM pg_class
       WHERE relname = 'tenants' AND relnamespace = 'public'::regnamespace`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].acl).not.toMatch(/[{,]=/);
    expect(r.rows[0].relrowsecurity).toBe(false);
  });
});
