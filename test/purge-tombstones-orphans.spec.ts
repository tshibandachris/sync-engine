import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe('purge_tenant_tombstones: orphaned object keys', () => {
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const siteId = randomUUID();
  const missionId = randomUUID();

  // Chaque test cree ses propres check-ins et attachments avec un tenant
  // partage, mais un avant chaque on nettoie ce qui reste.
  beforeEach(async () => {
    await pg.pool.query('DELETE FROM attachments WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM check_ins WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM missions WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM sites WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM sync_purge_state WHERE tenant_id = $1', [tenantId]);

    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)',
      [siteId, tenantId, 'site-orphan-test', 0, 0],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionId, tenantId, agentId, 'mission-orphan-test', siteId],
    );
  });

  async function seedCheckIn(opts: { deletedAt?: number }): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    await pg.pool.query(
      `INSERT INTO check_ins
         (id, tenant_id, mission_id, agent_id, check_in_time, check_out_time,
          check_in_lat, check_in_lng, check_in_method, created_at, updated_at,
          deleted_at, sync_seq)
       VALUES ($1, $2, $3, $4, $5, NULL, 0, 0, 'GPS', $5, $5, $6, 0)`,
      [id, tenantId, missionId, agentId, now, opts.deletedAt ?? null],
    );
    return id;
  }

  async function seedAttachment(checkInId: string, status: 'pending' | 'uploaded' = 'uploaded'): Promise<string> {
    const id = randomUUID();
    const objectKey = 'tenants/' + tenantId + '/checkins/' + checkInId + '/' + id + '.jpg';
    await pg.pool.query(
      `INSERT INTO attachments
         (id, tenant_id, check_in_id, agent_id, object_key, content_type,
          size_bytes, checksum_sha256, status, created_at, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, 'image/jpeg', 1024, $6, $7, $8, $9)`,
      [
        id, tenantId, checkInId, agentId, objectKey,
        'a'.repeat(64), status, Date.now(),
        status === 'uploaded' ? Date.now() : null,
      ],
    );
    return objectKey;
  }

  async function purge(ttlDays: number): Promise<{
    check_ins_deleted: number;
    orphaned_object_keys: string[];
  }> {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
      const res = await client.query('SELECT purge_tenant_tombstones($1::uuid, $2::int) AS result', [tenantId, ttlDays]);
      await client.query('COMMIT');
      return res.rows[0].result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  it('retourne un tableau vide quand rien ne cascade', async () => {
    const r = await purge(30);
    expect(r.check_ins_deleted).toBe(0);
    expect(r.orphaned_object_keys).toEqual([]);
  });

  it('retourne un object_key quand un check-in supprime cascade un attachment', async () => {
    const deletedAt = Date.now() - 40 * DAY_MS;
    const ci = await seedCheckIn({ deletedAt });
    const key = await seedAttachment(ci, 'uploaded');

    const r = await purge(30);
    expect(r.check_ins_deleted).toBe(1);
    expect(r.orphaned_object_keys).toEqual([key]);
  });

  it('concatène les object_keys de plusieurs check-ins cascades', async () => {
    const deletedAt = Date.now() - 40 * DAY_MS;
    const ci1 = await seedCheckIn({ deletedAt });
    const ci2 = await seedCheckIn({ deletedAt });
    const k1 = await seedAttachment(ci1);
    const k2 = await seedAttachment(ci2);

    const r = await purge(30);
    expect(r.check_ins_deleted).toBe(2);
    expect(r.orphaned_object_keys.sort()).toEqual([k1, k2].sort());
  });

  it('retourne aussi les object_keys des attachments pending', async () => {
    const deletedAt = Date.now() - 40 * DAY_MS;
    const ci = await seedCheckIn({ deletedAt });
    const kUp = await seedAttachment(ci, 'uploaded');
    // Un second attachment sur le meme check-in, en pending
    const kPend = await seedAttachment(ci, 'pending');

    const r = await purge(30);
    expect(r.check_ins_deleted).toBe(1);
    expect(r.orphaned_object_keys.sort()).toEqual([kUp, kPend].sort());
  });

  it('cascade effectivement : plus aucune ligne attachments apres purge', async () => {
    const deletedAt = Date.now() - 40 * DAY_MS;
    const ci = await seedCheckIn({ deletedAt });
    await seedAttachment(ci);

    const before = await pg.pool.query('SELECT count(*)::int AS n FROM attachments WHERE tenant_id = $1', [tenantId]);
    expect(before.rows[0].n).toBe(1);

    await purge(30);

    const after = await pg.pool.query('SELECT count(*)::int AS n FROM attachments WHERE tenant_id = $1', [tenantId]);
    expect(after.rows[0].n).toBe(0);
  });

  it('ne retourne pas les attachments des check-ins vivants', async () => {
    const liveCi = await seedCheckIn({});
    const liveKey = await seedAttachment(liveCi);

    const deletedAt = Date.now() - 40 * DAY_MS;
    const deadCi = await seedCheckIn({ deletedAt });
    const deadKey = await seedAttachment(deadCi);

    const r = await purge(30);
    expect(r.check_ins_deleted).toBe(1);
    expect(r.orphaned_object_keys).toEqual([deadKey]);
    expect(r.orphaned_object_keys).not.toContain(liveKey);

    // Le check-in vivant et son attachment sont intacts
    const alive = await pg.pool.query(
      'SELECT count(*)::int AS n FROM check_ins WHERE tenant_id = $1 AND deleted_at IS NULL',
      [tenantId],
    );
    expect(alive.rows[0].n).toBe(1);
  });
});
