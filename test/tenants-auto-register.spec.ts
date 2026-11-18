import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { withTenant } from '../src/with-tenant.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

const tenantCount = async (id: string): Promise<number> =>
  (await pg.pool.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [id])).rows[0].n;

const provisionTenant = async (id: string): Promise<void> => {
  await pg.pool.query(
    'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [id, Date.now()],
  );
};

describe('withTenant — existence explicite du tenant', () => {
  it('exécute normalement le callback pour un tenant existant', async () => {
    const tenantId = randomUUID();
    await provisionTenant(tenantId);
    const callback = vi.fn(async () => 'ok');

    await expect(withTenant(pg.appDb, tenantId, callback)).resolves.toBe('ok');

    expect(callback).toHaveBeenCalledOnce();
    expect(await tenantCount(tenantId)).toBe(1);
  });

  it('rejette un tenant absent avec TenantNotFoundError et son code stable, sans callback ni inscription', async () => {
    const tenantId = randomUUID();
    const callback = vi.fn(async () => 'must-not-run');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(withTenant(pg.appDb, tenantId, callback)).rejects.toMatchObject({
        name: 'TenantNotFoundError',
        code: 'TENANT_NOT_FOUND',
        tenantId,
      });

      expect(callback).not.toHaveBeenCalled();
      expect(await tenantCount(tenantId)).toBe(0);
      expect(errorLog).not.toHaveBeenCalledWith(
        expect.stringContaining('registration failed'),
        expect.anything(),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('propage une erreur SQL de lecture sans la convertir en TenantNotFoundError', async () => {
    const tenantId = randomUUID();
    const callback = vi.fn(async () => 'must-not-run');

    await pg.pool.query('REVOKE SELECT ON tenants FROM sync_app');
    try {
      await expect(withTenant(pg.appDb, tenantId, callback)).rejects.toMatchObject({
        cause: { code: '42501' },
      });
      expect(callback).not.toHaveBeenCalled();
      expect(await tenantCount(tenantId)).toBe(0);
    } finally {
      await pg.pool.query('GRANT SELECT ON tenants TO sync_app');
    }
  });

  it('bloque le callback de maintenance avant toute opération SQL si le tenant est absent', async () => {
    const tenantId = randomUUID();
    const maintenanceCallback = vi.fn(async () => ({ logsDeleted: 0 }));

    await expect(withTenant(pg.appDb, tenantId, maintenanceCallback)).rejects.toMatchObject({
      name: 'TenantNotFoundError',
      code: 'TENANT_NOT_FOUND',
      tenantId,
    });

    expect(maintenanceCallback).not.toHaveBeenCalled();
    expect(await tenantCount(tenantId)).toBe(0);
  });

  it('gère dix appels concurrents sur un tenant pré-provisionné sans interblocage', async () => {
    const tenantId = randomUUID();
    await provisionTenant(tenantId);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        withTenant(pg.appDb, tenantId, async () => index, { write: index % 2 === 0 }),
      ),
    );

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await tenantCount(tenantId)).toBe(1);
  });

  it('conserve la sérialisation advisory des transactions avec write: true', async () => {
    const tenantId = randomUUID();
    await provisionTenant(tenantId);

    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withTenant(pg.appDb, tenantId, async () => {
      markFirstEntered();
      await holdFirst;
      return 'first';
    }, { write: true });

    await firstEntered;

    let secondEntered = false;
    const second = withTenant(pg.appDb, tenantId, async () => {
      secondEntered = true;
      return 'second';
    }, { write: true });

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst();
    }

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(secondEntered).toBe(true);
  });

  it("préserve le comportement des identifiants mal formés sans inscription ni log d'erreur", async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const callback = vi.fn(async () => 'ok');
    const before = (await pg.pool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;

    try {
      await expect(withTenant(pg.appDb, 'not-a-uuid', callback)).resolves.toBe('ok');
      const after = (await pg.pool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;
      expect(after).toBe(before);
      expect(callback).toHaveBeenCalledOnce();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});
