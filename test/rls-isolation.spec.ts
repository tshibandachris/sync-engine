// test/rls-isolation.spec.ts
//
// Proves that RLS is enforced against a non-superuser, non-owner role.
// The main test pool connects as `postgres` (superuser), which bypasses RLS
// by PostgreSQL rule. `pg.appPool` connects as `sync_app`, which is subject
// to the policies defined in migration 010.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import * as schema from '../src/schema.js';
import { withTenant } from '../src/with-tenant.js';

describe('RLS isolation', () => {
  let pg: TestPostgres;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const siteA = randomUUID();
  const siteB = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();

    // Seed via the superuser pool (bypasses RLS).
    await pg.pool.query(
      `INSERT INTO sites (id, tenant_id, name, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [siteA, tenantA, 'site-A', 0, 0, siteB, tenantB, 'site-B', 0, 0],
    );
  }, 180_000);

  afterAll(async () => {
    await pg.stop();
  });

  it('fails closed: sync_app sees zero rows without set_config', async () => {
    const res = await pg.appPool.query('SELECT id FROM sites');
    expect(res.rows).toHaveLength(0);
  });

  it('sync_app sees only its tenant after set_config', async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);

      const res = await client.query('SELECT id FROM sites');
      const ids = res.rows.map((r) => r.id);
      expect(ids).toEqual([siteA]);

      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('sync_app cannot read another tenant, even with an explicit WHERE', async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);

      const res = await client.query('SELECT id FROM sites WHERE id = $1', [siteB]);
      expect(res.rows).toHaveLength(0);

      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('rejects INSERT with a mismatched tenant_id (WITH CHECK)', async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);

      const evilId = randomUUID();
      await expect(
        client.query(
          `INSERT INTO sites (id, tenant_id, name, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5)`,
          [evilId, tenantB, 'evil', 0, 0],
        ),
      ).rejects.toThrow(/row-level security policy/i);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('withTenant wrapper makes sync_app see its own data', async () => {
    const rows = await withTenant(pg.appDb, tenantA, async (tx) => {
      return tx.select().from(schema.sites);
    });

    expect(rows.map((r) => r.id)).toEqual([siteA]);
  });

  it('withTenant wrapper does not leak across tenants', async () => {
    const rowsA = await withTenant(pg.appDb, tenantA, async (tx) => {
      return tx.select().from(schema.sites);
    });
    const rowsB = await withTenant(pg.appDb, tenantB, async (tx) => {
      return tx.select().from(schema.sites);
    });

    expect(rowsA.map((r) => r.id)).toEqual([siteA]);
    expect(rowsB.map((r) => r.id)).toEqual([siteB]);
  });
});