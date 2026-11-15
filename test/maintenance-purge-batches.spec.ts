import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;
let pg: TestPostgres;

beforeAll(async () => { pg = await startTestPostgres(); }, 180_000);
afterAll(async () => { await pg?.stop(); }, 30_000);

describe('bounded tenant maintenance purges', () => {
  it('purges at most one batch of expired tombstones for the requested tenant', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const agentId = randomUUID();
    const siteA = randomUUID();
    const siteB = randomUUID();
    const missionA = randomUUID();
    const missionB = randomUUID();
    const now = Date.now();
    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1,$2,$3,0,0),($4,$5,$6,0,0)',
      [siteA, tenantA, 'batch-a', siteB, tenantB, 'batch-b'],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1,$2,$3,$4,$5),($6,$7,$3,$8,$9)',
      [missionA, tenantA, agentId, 'mission-a', siteA, missionB, tenantB, 'mission-b', siteB],
    );
    await pg.pool.query(
      'INSERT INTO check_ins (id, tenant_id, mission_id, agent_id, check_in_time, check_in_lat, check_in_lng, check_in_method, created_at, updated_at, deleted_at, sync_seq) ' +
      'SELECT gen_random_uuid(), $1, $2, $3, $4, 0, 0, $5, $4, $4, $6, 0 FROM generate_series(1, 5001)',
      [tenantA, missionA, agentId, now, 'GPS', now - 40 * DAY_MS],
    );
    await pg.pool.query(
      'INSERT INTO check_ins (id, tenant_id, mission_id, agent_id, check_in_time, check_in_lat, check_in_lng, check_in_method, created_at, updated_at, deleted_at, sync_seq) VALUES ($1,$2,$3,$4,$5,0,0,$6,$5,$5,NULL,0),($7,$8,$9,$4,$5,0,0,$6,$5,$5,$10,0)',
      [randomUUID(), tenantA, missionA, agentId, now, 'GPS', randomUUID(), tenantB, missionB, now - 40 * DAY_MS],
    );

    const service = new SyncMaintenanceService(pg.maintenanceDb);
    const result = await service.purgeTenantTombstones(tenantA, 30);
    expect(result.checkInsDeleted).toBe(BATCH_SIZE);

    const counts = await pg.pool.query(
      'SELECT tenant_id, count(*)::int AS rows, count(*) FILTER (WHERE deleted_at IS NOT NULL AND deleted_at < $2)::int AS expired ' +
      'FROM check_ins WHERE tenant_id = ANY($1::uuid[]) GROUP BY tenant_id ORDER BY tenant_id',
      [[tenantA, tenantB], now - 30 * DAY_MS],
    );
    const a = counts.rows.find((row: any) => row.tenant_id === tenantA);
    const b = counts.rows.find((row: any) => row.tenant_id === tenantB);
    expect(a?.expired).toBe(1);
    expect(a?.rows).toBe(2);
    expect(b?.expired).toBe(1);
    expect(b?.rows).toBe(1);
  });

  it('purges at most one batch of expired sync logs for the requested tenant', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const now = Date.now();
    await pg.pool.query(
      'INSERT INTO sync_logs (id, request_id, tenant_id, operation, status_code, started_at, duration_ms, records_in, records_out, conflicts, errors) ' +
      "SELECT gen_random_uuid(), gen_random_uuid(), $1, 'pull', 200, $2, 1, 0, 0, 0, 0 FROM generate_series(1, 5001)",
      [tenantA, now - 40 * DAY_MS],
    );
    await pg.pool.query(
      "INSERT INTO sync_logs (id, request_id, tenant_id, operation, status_code, started_at, duration_ms, records_in, records_out, conflicts, errors) " +
      "VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'pull', 200, $2, 1, 0, 0, 0, 0), " +
      "(gen_random_uuid(), gen_random_uuid(), $3, 'pull', 200, $4, 1, 0, 0, 0, 0)",
      [tenantA, now, tenantB, now - 40 * DAY_MS],
    );

    const service = new SyncMaintenanceService(pg.maintenanceDb);
    const result = await service.purgeSyncLogs(tenantA, 30);
    expect(result.logsDeleted).toBe(BATCH_SIZE);
    const remaining = await pg.pool.query(
      'SELECT tenant_id, count(*)::int AS rows, count(*) FILTER (WHERE started_at < $2)::int AS expired ' +
      'FROM sync_logs WHERE tenant_id = ANY($1::uuid[]) GROUP BY tenant_id ORDER BY tenant_id',
      [[tenantA, tenantB], now - 30 * DAY_MS],
    );
    const a = remaining.rows.find((row: any) => row.tenant_id === tenantA);
    const b = remaining.rows.find((row: any) => row.tenant_id === tenantB);
    expect(a?.expired).toBe(1);
    expect(a?.rows).toBe(2);
    expect(b?.expired).toBe(1);
    expect(b?.rows).toBe(1);
  });
});
