import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET } from './helpers/jwt.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { SyncController } from '../src/sync.controller.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { SyncLogService } from '../src/observability/sync-log.service.js';
import { SyncLogInterceptor } from '../src/observability/sync-log.interceptor.js';
import { renderMetrics, resetMetrics } from '../src/observability/metrics.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
});

describe('SyncLog interceptor', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let baseUrl: string;

  const tenantId = randomUUID();
  const agentId = randomUUID();
  const siteId = randomUUID();
  const missionId = randomUUID();

  const token = (): string => jwt.sign({ sub: agentId, tenantId });

  async function http(
    routePath: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(baseUrl + routePath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: res.status, json };
  }

  /**
   * The interceptor writes fire-and-forget on the response 'finish' event.
   * Poll until at least `count` rows are visible, or fail after 3s.
   */
  async function waitForLogCount(count: number, timeoutMs = 3000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await pg.pool.query(
        'SELECT * FROM sync_logs WHERE tenant_id = $1 ORDER BY started_at ASC',
        [tenantId],
      );
      if (r.rowCount !== null && r.rowCount >= count) return r.rows;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const last = await pg.pool.query(
      'SELECT * FROM sync_logs WHERE tenant_id = $1',
      [tenantId],
    );
    throw new Error('Timeout: expected ' + count + ' sync_logs, got ' + last.rowCount);
  }

  async function clearLogs(): Promise<void> {
    await pg.pool.query('DELETE FROM sync_logs WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM sync_purge_state WHERE tenant_id = $1', [tenantId]);
    resetMetrics();
  }

  beforeAll(async () => {
    // Seed a site and a mission so a pull has something to return and a
    // push has a valid target mission. Superuser pool: seeds bypass RLS.
    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)',
      [siteId, tenantId, 'site-sync-log', 0, 0],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionId, tenantId, agentId, 'mission-sync-log', siteId],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '30d' },
        }),
      ],
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncLogService, useFactory: (d: any) => new SyncLogService(d), inject: ['DRIZZLE_DB'] },
        { provide: APP_INTERCEPTOR, useClass: SyncLogInterceptor },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    jwt = moduleRef.get(JwtService);
    await app.listen(0);
    baseUrl = 'http://127.0.0.1:' + (app.getHttpServer().address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await clearLogs();
  });

  it('records a pull as operation=pull with records_out matching the payload', async () => {
    const res = await http('/sync/pull', { last_pulled_at: 0 });
    expect(res.status).toBe(201);

    const logs = await waitForLogCount(1);
    expect(logs).toHaveLength(1);
    const log = logs[0];

    expect(log.operation).toBe('pull');
    expect(Number(log.status_code)).toBe(201);
    expect(Number(log.errors)).toBe(0);
    expect(Number(log.records_out)).toBeGreaterThan(0);
    expect(log.agent_id).toBe(agentId);
    expect(log.tenant_id).toBe(tenantId);
    expect(log.request_id).toMatch(/^[0-9a-f-]{36}$/i);

    const metrics = await renderMetrics();
    expect(metrics).toMatch(/sync_requests_total\{operation="pull",status="201"\} 1/);
  });

  it('records a fresh push with idempotency=miss', async () => {
    const checkInId = randomUUID();
    const res = await http(
      '/sync/push',
      {
        changes: {
          check_ins: {
            created: [{
              id: checkInId,
              mission_id: missionId,
              check_in_time: Date.now(),
              check_in_lat: 0,
              check_in_lng: 0,
              check_in_method: 'GPS',
            }],
          },
        },
      },
      { 'Idempotency-Key': 'log-test-fresh' },
    );
    expect(res.status).toBe(201);

    const logs = await waitForLogCount(1);
    const log = logs[0];

    expect(log.operation).toBe('push');
    expect(Number(log.status_code)).toBe(201);
    expect(log.idempotency).toBe('miss');
    expect(Number(log.records_in)).toBe(1);
    expect(Number(log.records_out)).toBe(1);

    const metrics = await renderMetrics();
    expect(metrics).toMatch(/sync_idempotency_total\{result="miss"\} 1/);
    expect(metrics).toMatch(/sync_requests_total\{operation="push",status="201"\} 1/);
  });

  it('records a replayed push with idempotency=hit and no applied work', async () => {
    const body = {
      changes: {
        check_ins: {
          created: [{
            id: randomUUID(),
            mission_id: missionId,
            check_in_time: Date.now(),
            check_in_lat: 0,
            check_in_lng: 0,
            check_in_method: 'GPS',
          }],
        },
      },
    };

    const first = await http('/sync/push', body, { 'Idempotency-Key': 'log-test-replay' });
    expect(first.status).toBe(201);
    await waitForLogCount(1);

    const second = await http('/sync/push', body, { 'Idempotency-Key': 'log-test-replay' });
    expect(second.status).toBe(201);

    const logs = await waitForLogCount(2);
    expect(logs).toHaveLength(2);

    const replay = logs.find((l) => l.idempotency === 'hit');
    expect(replay, 'no log row with idempotency=hit').toBeDefined();
    expect(replay.operation).toBe('push');
    expect(Number(replay.records_out)).toBe(0);
    expect(Number(replay.conflicts)).toBe(0);

    const metrics = await renderMetrics();
    expect(metrics).toMatch(/sync_idempotency_total\{result="hit"\} 1/);
    expect(metrics).toMatch(/sync_idempotency_total\{result="miss"\} 1/);
  });

  it('records a 410 GONE with error_code and errors=1', async () => {
    await pg.pool.query(
      'INSERT INTO sync_purge_state (tenant_id, purged_up_to_seq, updated_at) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO UPDATE SET purged_up_to_seq = EXCLUDED.purged_up_to_seq, updated_at = EXCLUDED.updated_at',
      [tenantId, 999, Date.now()],
    );

    const res = await http('/sync/pull', { last_pulled_at: 1 });
    expect(res.status).toBe(410);

    const logs = await waitForLogCount(1);
    const log = logs[0];

    expect(log.operation).toBe('pull');
    expect(Number(log.status_code)).toBe(410);
    expect(Number(log.errors)).toBe(1);
    expect(log.error_code).toBe('CURSOR_TOO_OLD');

    const metrics = await renderMetrics();
    expect(metrics).toMatch(/sync_requests_total\{operation="pull",status="410"\} 1/);
    const staleLine = new RegExp('sync_stale_cursor_total\\{tenant_id="' + tenantId + '"\\} 1');
    expect(metrics).toMatch(staleLine);
  });
});
