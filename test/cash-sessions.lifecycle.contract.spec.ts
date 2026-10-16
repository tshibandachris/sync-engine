import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncController } from '../src/sync.controller.js';
import { CashSessionController } from '../src/cash-session.controller.js';
import { CashSessionService } from '../src/cash-session.service.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET, TEST_TENANT_ID, createTestJwtService, signAgentToken } from './helpers/jwt.js';

describe('Cash sessions lifecycle', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let token: string;
  const tenantId = TEST_TENANT_ID;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const jwt = createTestJwtService();
    token = signAgentToken(randomUUID(), jwt, tenantId);
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '30d' } })],
      controllers: [SyncController, CashSessionController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        { provide: CashSessionService, useFactory: (d: any) => new CashSessionService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    await app.init();
  });

  afterAll(async () => { await app.close(); await pg.stop(); });

  beforeEach(async () => {
    await pg.pool.query('TRUNCATE sales, cash_sessions, staff, products, check_ins, missions, sites, sync_idempotency_keys, sync_conflicts RESTART IDENTITY CASCADE');
    await pg.pool.query("ALTER SEQUENCE global_sync_seq RESTART WITH 1");
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [tenantId, Date.now()]);
  });

  async function staffId() {
    const id = randomUUID(), now = Date.now();
    await pg.pool.query("INSERT INTO staff (id, tenant_id, display_name, role, is_active, created_at, updated_at, sync_seq, first_sync_seq) VALUES ($1, $2, 'Cashier', 'cashier', true, $3, $3, nextval('global_sync_seq'), nextval('global_sync_seq'))", [id, tenantId, now]);
    return id;
  }

  function payload(staff: string, extra: Record<string, unknown> = {}) {
    return { id: randomUUID(), staffId: staff, terminalLabel: 'Till 1', openedAt: Date.now(), openingAmount: 10000, status: 'open', notes: null, createdAt: Date.now(), lastKnownSyncSeq: 0, ...extra };
  }

  async function push(item: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/sync/push').set('Authorization', 'Bearer ' + token).send({ changes: { cash_sessions: [item] } });
  }

  it('creates an open session and returns 200 for an idempotent UUID retry', async () => {
    const item = payload(await staffId());
    expect((await push(item)).status).toBe(201);
    const retry = await push(item);
    expect(retry.status).toBe(200);
    expect(retry.body.cash_sessions[0].status).toBe('idempotent');
  });

  it('returns a distinct 409 when a cashier already has an open session', async () => {
    const staff = await staffId();
    expect((await push(payload(staff))).status).toBe(201);
    const second = await push(payload(staff));
    expect(second.status).toBe(409);
    expect(second.body.message).toContain('déjà une session de caisse ouverte');
  });

  it('computes closing totals on the server and refuses reopening', async () => {
    const item = payload(await staffId());
    expect((await push(item)).status).toBe(201);
    const closed = await request(app.getHttpServer()).post('/cash-sessions/' + item.id + '/close')
      .set('Authorization', 'Bearer ' + token)
      .send({ closingAmount: 12500, expectedAmount: 12500, difference: 0 });
    expect(closed.status).toBe(201);
    expect(closed.body.expectedAmount).toBe(10000);
    expect(closed.body.difference).toBe(2500);
    const reopen = await push({ id: item.id, status: 'open', lastKnownSyncSeq: closed.body.syncSeq });
    expect(reopen.status).toBe(409);
  });
  it('rejects closed creation and permits only notes changes after closing', async () => {
    const staff = await staffId();
    const invalid = await push(payload(staff, { status: 'closed' }));
    expect(invalid.status).toBe(409);

    const item = payload(staff);
    expect((await push(item)).status).toBe(201);
    const closed = await request(app.getHttpServer()).post('/cash-sessions/' + item.id + '/close')
      .set('Authorization', 'Bearer ' + token).send({ closingAmount: 10000 });
    expect(closed.status).toBe(201);

    const notes = await push({ id: item.id, status: 'closed', notes: 'Verified', lastKnownSyncSeq: closed.body.syncSeq });
    expect(notes.status).toBe(201);
    expect(notes.body.cash_sessions[0].status).toBe('applied');

    const mutation = await push({
      id: item.id, status: 'closed', openingAmount: 1,
      lastKnownSyncSeq: notes.body.cash_sessions[0].sync_seq,
    });
    expect(mutation.status).toBe(409);
    expect(mutation.body.message).toContain('notes');
  });

});
