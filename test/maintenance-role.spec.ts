import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  assertMaintenanceRole,
  fetchMaintenanceRole,
} from '../src/maintenance-role.js';

function poolWith(role: {
  name: string;
  superuser: boolean;
  bypassrls: boolean;
}): Pool {
  return {
    query: async () => ({ rows: [role] }),
  } as unknown as Pool;
}

describe('assertMaintenanceRole', () => {
  it('accepts a non-privileged role', async () => {
    const pool = poolWith({ name: 'sync_app', superuser: false, bypassrls: false });
    await expect(assertMaintenanceRole(pool)).resolves.toBeUndefined();
  });

  it('refuses a superuser', async () => {
    const pool = poolWith({ name: 'postgres', superuser: true, bypassrls: false });
    await expect(assertMaintenanceRole(pool)).rejects.toThrow(/superuser=true/);
  });

  it('refuses a BYPASSRLS role', async () => {
    const pool = poolWith({ name: 'rls_bypasser', superuser: false, bypassrls: true });
    await expect(assertMaintenanceRole(pool)).rejects.toThrow(/bypassrls=true/);
  });

  it('refuses a role that is both', async () => {
    const pool = poolWith({ name: 'root', superuser: true, bypassrls: true });
    await expect(assertMaintenanceRole(pool)).rejects.toThrow(/refused to start/);
  });

  it('fetchMaintenanceRole returns the parsed attributes', async () => {
    const pool = poolWith({ name: 'sync_app', superuser: false, bypassrls: false });
    await expect(fetchMaintenanceRole(pool)).resolves.toEqual({
      name: 'sync_app',
      superuser: false,
      bypassrls: false,
    });
  });
});
