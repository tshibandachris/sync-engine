import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { withTenant } from '../src/with-tenant.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';

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
        code: '42501',
      });
      expect(callback).not.toHaveBeenCalled();
      expect(await tenantCount(tenantId)).toBe(0);
    } finally {
      await pg.pool.query('GRANT SELECT ON tenants TO sync_app');
    }
  });

  it('refuse explicitement une opération de maintenance sur un tenant absent', async () => {
    const tenantId = randomUUID();
    const maintenance = new SyncMaintenanceService(pg.appDb);

    await expect(maintenance.purgeExpiredDeviceProofNonces(tenantId)).rejects.toMatchObject({
      name: 'TenantNotFoundError',
      code: 'TENANT_NOT_FOUND',
      tenantId,
    });

    expect(await tenantCount(tenantId)).toBe(0);
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
});
