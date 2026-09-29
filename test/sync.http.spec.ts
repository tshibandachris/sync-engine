import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import * as schema from '../src/schema.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { SyncController } from '../src/sync.controller.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import {
  TEST_JWT_SECRET,
  createTestJwtService,
  signAgentToken,
  signExpiredToken,
  signInvalidToken,
} from './helpers/jwt.js';

describe('Sync Engine / HTTP', () => {
  let pg: TestPostgres;
  let db: NodePgDatabase<typeof schema>;
  let app: INestApplication;
  let jwt: JwtService;
  let tokenA: string;

  const agentA = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const missionA = randomUUID();
  const siteA = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    db = drizzle(pg.pool, { schema });
    jwt = createTestJwtService();
    tokenA = signAgentToken(agentA, jwt, tenantA);

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '30d' },
        }),
      ],
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: db },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
  });

  beforeEach(async () => {
    await pg.pool.query('TRUNCATE check_ins, missions, sites, sync_idempotency_keys, sync_conflicts RESTART IDENTITY CASCADE');
    await pg.pool.query('ALTER SEQUENCE global_sync_seq RESTART WITH 1');

    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)',
      [siteA, tenantA, 'Site A', 48.85, 2.35],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionA, tenantA, agentA, 'Mission A', siteA],
    );
  });

  it('rejects a request without Authorization header', async () => {
    const res = await request(app.getHttpServer()).post('/sync/pull').send({});
    expect(res.status).toBe(401);
  });

  it('rejects a request with an invalid token signature', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', 'Bearer ' + signInvalidToken())
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects a request with an expired token', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', 'Bearer ' + signExpiredToken(agentA, jwt))
      .send({});
    expect(res.status).toBe(401);
  });

  it('POST /sync/pull returns the mission and site for the agent', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ last_pulled_at: null, limit: 500 });

    expect(res.status).toBe(201);
    expect(res.body.changes.missions.created).toHaveLength(1);
    expect(res.body.changes.missions.created[0].id).toBe(missionA);
    expect(res.body.changes.sites.created).toHaveLength(1);
  });

  it('POST /sync/push creates a check-in', async () => {
    const id = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({
        changes: {
          check_ins: {
            created: [
              { id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' },
            ],
          },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.applied.created).toBe(1);
    expect(res.body.conflicts).toHaveLength(0);
  });

  it('POST /sync/push with stale version returns a conflict', async () => {
    const id = randomUUID();
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });

    await pg.pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);

    const res = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });

    expect(res.status).toBe(201);
    expect(res.body.applied.updated).toBe(0);
    expect(res.body.conflicts).toHaveLength(1);
  });

  it('GET /sync/conflicts lists pending conflicts', async () => {
    const id = randomUUID();
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });

    await pg.pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });

    const res = await request(app.getHttpServer())
      .get('/sync/conflicts?status=pending')
      .set('Authorization', 'Bearer ' + tokenA);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].entityId).toBe(id);
  });

  it('POST /sync/conflicts/:id/resolve marks the conflict resolved', async () => {
    const id = randomUUID();
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });

    await pg.pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const pushed = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });

    const conflictId = pushed.body.conflicts[0].conflict_id;

    const res = await request(app.getHttpServer())
      .post('/sync/conflicts/' + conflictId + '/resolve')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ resolution: 'server', resolved_by: agentA });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
  });

  it('does not leak missions across tenants', async () => {
    const tokenB = signAgentToken(agentA, jwt, tenantB);

    const res = await request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ last_pulled_at: null, limit: 500 });

    expect(res.status).toBe(201);
    expect(res.body.changes.missions.created).toHaveLength(0);
    expect(res.body.changes.sites.created).toHaveLength(0);
  });

  it('does not allow a check-in push into another tenant mission', async () => {
    const tokenB = signAgentToken(agentA, jwt, tenantB);
    const id = randomUUID();

    const res = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenB)
      .send({
        changes: {
          check_ins: {
            created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }],
          },
        },
      });

    expect(res.status).toBe(403);
  });

  it('does not allow resolving another tenant conflict', async () => {
    const id = randomUUID();
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });

    await pg.pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    const pushed = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });

    const conflictId = pushed.body.conflicts[0].conflict_id;
    const tokenB = signAgentToken(agentA, jwt, tenantB);

    const res = await request(app.getHttpServer())
      .post('/sync/conflicts/' + conflictId + '/resolve')
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ resolution: 'server', resolved_by: agentA });

    expect(res.status).toBe(403);
  });

  it('does not list conflicts from another tenant', async () => {
    const id = randomUUID();
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { created: [{ id, mission_id: missionA, check_in_time: Date.now(), check_in_lat: 1, check_in_lng: 2, check_in_method: 'GPS' }] } } });

    await pg.pool.query("UPDATE check_ins SET sync_seq = nextval('global_sync_seq') WHERE id = $1", [id]);
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ changes: { check_ins: { updated: [{ id, version: 1, check_out_time: Date.now() }] } } });

    const tokenB = signAgentToken(agentA, jwt, tenantB);
    const res = await request(app.getHttpServer())
      .get('/sync/conflicts?status=pending')
      .set('Authorization', 'Bearer ' + tokenB);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});