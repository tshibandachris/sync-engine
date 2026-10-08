import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe('purgeTenantPendingAttachments', () => {
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const siteId = randomUUID();
  const missionId = randomUUID();
  const checkInId = randomUUID();

  let svc: SyncMaintenanceService;

  beforeAll(() => {
    svc = new SyncMaintenanceService(pg.appDb);
  });

  beforeEach(async () => {
    await pg.pool.query('DELETE FROM attachments WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM check_ins WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM missions WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM sites WHERE tenant_id = $1', [tenantId]);

    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, 0, 0)',
      [siteId, tenantId, 'site-pending'],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionId, tenantId, agentId, 'mission-pending', siteId],
    );
    await pg.pool.query(
      `INSERT INTO check_ins
         (id, tenant_id, mission_id, agent_id, check_in_time, check_out_time,
          check_in_lat, check_in_lng, check_in_method, created_at, updated_at,
          deleted_at, sync_seq)
       VALUES ($1, $2, $3, $4, $5, NULL, 0, 0, 'GPS', $5, $5, NULL, 0)`,
      [checkInId, tenantId, missionId, agentId, Date.now()],
    );
  });

  async function seed(opts: {
    status: 'pending' | 'uploaded';
    ageDays: number;
  }): Promise<string> {
    const id = randomUUID();
    const createdAt = Date.now() - opts.ageDays * DAY_MS;
    const objectKey = 'tenants/' + tenantId + '/checkins/' + checkInId + '/' + id + '.jpg';
    await pg.pool.query(
      `INSERT INTO attachments
         (id, tenant_id, check_in_id, agent_id, object_key, content_type,
          size_bytes, checksum_sha256, status, created_at, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, 'image/jpeg', 1024, $6, $7, $8, $9)`,
      [
        id, tenantId, checkInId, agentId, objectKey,
        'a'.repeat(64), opts.status, createdAt,
        opts.status === 'uploaded' ? createdAt : null,
      ],
    );
    return id;
  }

  async function listIds(): Promise<Set<string>> {
    const r = await pg.pool.query(
      'SELECT id FROM attachments WHERE tenant_id = $1',
      [tenantId],
    );
    return new Set(r.rows.map((row: { id: string }) => String(row.id)));
  }

  it('supprime les pending de plus de 7 jours', async () => {
    const old = await seed({ status: 'pending', ageDays: 10 });
    const recent = await seed({ status: 'pending', ageDays: 2 });

    const r = await svc.purgeTenantPendingAttachments(tenantId);
    expect(r.deleted).toBe(1);

    const remaining = await listIds();
    expect(remaining.has(old)).toBe(false);
    expect(remaining.has(recent)).toBe(true);
  });

  it('respecte la limite : 6 jours restent, 8 jours partent', async () => {
    const d6 = await seed({ status: 'pending', ageDays: 6 });
    const d8 = await seed({ status: 'pending', ageDays: 8 });

    const r = await svc.purgeTenantPendingAttachments(tenantId, 7);
    expect(r.deleted).toBe(1);

    const remaining = await listIds();
    expect(remaining.has(d6)).toBe(true);
    expect(remaining.has(d8)).toBe(false);
  });

  it('ne touche pas aux uploaded, meme anciens', async () => {
    const up = await seed({ status: 'uploaded', ageDays: 30 });
    const pending = await seed({ status: 'pending', ageDays: 30 });

    const r = await svc.purgeTenantPendingAttachments(tenantId);
    expect(r.deleted).toBe(1);

    const remaining = await listIds();
    expect(remaining.has(up)).toBe(true);
    expect(remaining.has(pending)).toBe(false);
  });

  it('ne touche pas aux pending des autres tenants', async () => {
    const otherTenant = randomUUID();
    const mine = await seed({ status: 'pending', ageDays: 30 });

    const otherSiteId = randomUUID();
    const otherMissionId = randomUUID();
    const otherCheckInId = randomUUID();
    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, 0, 0)',
      [otherSiteId, otherTenant, 'other-site'],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [otherMissionId, otherTenant, agentId, 'other-mission', otherSiteId],
    );
    await pg.pool.query(
      `INSERT INTO check_ins
         (id, tenant_id, mission_id, agent_id, check_in_time, check_out_time,
          check_in_lat, check_in_lng, check_in_method, created_at, updated_at,
          deleted_at, sync_seq)
       VALUES ($1, $2, $3, $4, $5, NULL, 0, 0, 'GPS', $5, $5, NULL, 0)`,
      [otherCheckInId, otherTenant, otherMissionId, agentId, Date.now()],
    );
    const otherId = randomUUID();
    await pg.pool.query(
      `INSERT INTO attachments
         (id, tenant_id, check_in_id, agent_id, object_key, content_type,
          size_bytes, checksum_sha256, status, created_at, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, 'image/jpeg', 1024, $6, 'pending', $7, NULL)`,
      [
        otherId, otherTenant, otherCheckInId, agentId,
        'tenants/' + otherTenant + '/checkins/' + otherCheckInId + '/x.jpg',
        'a'.repeat(64), Date.now() - 30 * DAY_MS,
      ],
    );

    try {
      const r = await svc.purgeTenantPendingAttachments(tenantId);
      expect(r.deleted).toBe(1);
      expect((await listIds()).has(mine)).toBe(false);

      const other = await pg.pool.query(
        'SELECT count(*)::int AS n FROM attachments WHERE tenant_id = $1',
        [otherTenant],
      );
      expect(other.rows[0].n).toBe(1);
    } finally {
      await pg.pool.query('DELETE FROM attachments WHERE tenant_id = $1', [otherTenant]);
      await pg.pool.query('DELETE FROM check_ins WHERE tenant_id = $1', [otherTenant]);
      await pg.pool.query('DELETE FROM missions WHERE tenant_id = $1', [otherTenant]);
      await pg.pool.query('DELETE FROM sites WHERE tenant_id = $1', [otherTenant]);
    }
  });

  it('retourne 0 quand rien a purger', async () => {
    await seed({ status: 'uploaded', ageDays: 60 });
    const r = await svc.purgeTenantPendingAttachments(tenantId);
    expect(r.deleted).toBe(0);
  });

  it('rejette un ttl negatif', async () => {
    await expect(svc.purgeTenantPendingAttachments(tenantId, -1)).rejects.toThrow(/ttlDays/);
  });
});
