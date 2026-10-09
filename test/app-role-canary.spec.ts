import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { pgErrorChain } from './helpers/pg-error.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';

const TENANT_GUC = 'app.current_tenant_id';

describe('test harness canary: appDb is subject to RLS', () => {
  let pg: TestPostgres;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    for (const [tenant, name] of [
      [tenantA, 'site-a'],
      [tenantB, 'site-b'],
    ] as const) {
      await pg.pool.query(
        'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, 0, 0)',
        [randomUUID(), tenant, name],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('connects as a role that cannot bypass RLS', async () => {
    await assertRunsAsAppRole(pg.appDb);
  });

  it('fails closed: without a tenant context the app role sees no rows', async () => {
    const res = await pg.appDb.execute(sql`SELECT count(*)::int AS n FROM sites`);
    expect(res.rows[0].n).toBe(0);

    const all = await pg.pool.query('SELECT count(*)::int AS n FROM sites');
    expect(all.rows[0].n).toBe(2);
  });

  it('with a tenant context the app role sees only that tenant', async () => {
    const seen = await pg.appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config(${TENANT_GUC}, ${tenantA}, true)`);
      const r = await tx.execute(sql`SELECT tenant_id FROM sites`);
      return r.rows.map((row: any) => String(row.tenant_id));
    });
    expect(seen).toEqual([tenantA]);
  });

  it('the tenant context does not leak out of its transaction', async () => {
    await pg.appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config(${TENANT_GUC}, ${tenantA}, true)`);
    });
    const res = await pg.appDb.execute(sql`SELECT count(*)::int AS n FROM sites`);
    expect(res.rows[0].n).toBe(0);
  });

  it('cannot write a row for another tenant (WITH CHECK)', async () => {
    await expect(
      pg.appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config(${TENANT_GUC}, ${tenantA}, true)`);
        await tx.execute(
          sql`INSERT INTO sites (id, tenant_id, name, latitude, longitude)
              VALUES (${randomUUID()}, ${tenantB}::uuid, 'forged', 0, 0)`,
        );
      }),
    ).rejects.toSatisfy((e: unknown) => /row-level security/i.test(pgErrorChain(e)));
  });
});
