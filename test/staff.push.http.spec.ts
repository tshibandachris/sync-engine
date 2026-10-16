import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncController } from '../src/sync.controller.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import {
  TEST_JWT_SECRET,
  TEST_TENANT_ID,
  createTestJwtService,
  signAgentToken,
} from './helpers/jwt.js';

describe('Staff push / PIN boundary and owner invariant', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let jwt: JwtService;
  let token: string;

  const tenantId = TEST_TENANT_ID;
  const agentId = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    jwt = createTestJwtService();
    token = signAgentToken(agentId, jwt, tenantId);

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
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
  });

  beforeEach(async () => {
    await pg.pool.query(
      'TRUNCATE staff, products, check_ins, missions, sites, sync_idempotency_keys, sync_conflicts RESTART IDENTITY CASCADE',
    );
    await pg.pool.query("ALTER SEQUENCE global_sync_seq RESTART WITH 1");
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
  });

  async function insertStaff(input: {
    id?: string;
    displayName: string;
    role: 'owner' | 'manager' | 'cashier';
    isActive?: boolean;
    deletedAt?: number | null;
    pinHash?: string | null;
    pinAlgo?: 'bcrypt' | 'argon2id' | null;
  }) {
    const id = input.id ?? randomUUID();
    await pg.pool.query(
      `INSERT INTO staff
        (id, tenant_id, display_name, role, pin_hash, pin_algo, is_active,
         created_at, updated_at, deleted_at, sync_seq, first_sync_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, nextval('global_sync_seq'), nextval('global_sync_seq'))`,
      [
        id, tenantId, input.displayName, input.role, input.pinHash ?? null,
        input.pinAlgo ?? null, input.isActive ?? true, Date.now(), input.deletedAt ?? null,
      ],
    );
    const result = await pg.pool.query(
      'SELECT sync_seq FROM staff WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    return { id, syncSeq: Number(result.rows[0].sync_seq) };
  }

  const payload = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    displayName: 'Offline Cashier',
    role: 'cashier',
    isActive: true,
    createdAt: Date.now(),
    lastKnownSyncSeq: 0,
    ...overrides,
  });

  it.each([
    ['pinHash', '$2b$12$secret'],
    ['pin_hash', '$2b$12$secret'],
    ['pinAlgo', 'bcrypt'],
    ['pin_algo', 'bcrypt'],
    ['plaintextPin', '1234'],
    ['pin', '1234'],
    ['PIN_HASH', '$argon2id$v=19$secret'],
  ])('rejects %s with the dedicated PIN error', async (key, value) => {
    const item = { ...payload(), [key]: value };
    const response = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + token)
      .send({ changes: { staff: [item] } });

    expect(response.status).toBe(400);
    expect(response.text).toContain('PIN cannot be set through sync. Use POST /staff/:id/pin');
    const rows = await pg.pool.query('SELECT id FROM staff WHERE tenant_id = $1', [tenantId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('creates an offline staff member without touching credential columns', async () => {
    const item = payload();
    const response = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + token)
      .send({ changes: { staff: [item] } });

    expect(response.status).toBe(201);
    expect(response.body.applied.created).toBe(1);
    expect(response.text).not.toMatch(/pinHash|pin_hash|pinAlgo|pin_algo|authSubject|auth_subject|plaintextPin/i);
    const stored = await pg.pool.query(
      'SELECT display_name, role, is_active, pin_hash, pin_algo, auth_subject FROM staff WHERE id = $1 AND tenant_id = $2',
      [item.id, tenantId],
    );
    expect(stored.rows).toEqual([{
      display_name: 'Offline Cashier',
      role: 'cashier',
      is_active: true,
      pin_hash: null,
      pin_algo: null,
      auth_subject: null,
    }]);
  });

  it('returns 409 when the only active owner is soft-deleted', async () => {
    const owner = await insertStaff({ displayName: 'Only Owner', role: 'owner' });
    const response = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + token)
      .send({
        changes: {
          staff: [payload({
            id: owner.id,
            displayName: 'Only Owner',
            role: 'owner',
            deletedAt: Date.now(),
            lastKnownSyncSeq: owner.syncSeq,
          })],
        },
      });

    expect(response.status).toBe(409);
    expect(response.text).toContain('dernier owner actif');
    const stored = await pg.pool.query('SELECT deleted_at FROM staff WHERE id = $1', [owner.id]);
    expect(stored.rows[0].deleted_at).toBeNull();
  });

  it('allows soft-deleting an owner when another active owner remains', async () => {
    const ownerA = await insertStaff({ displayName: 'Owner A', role: 'owner' });
    await insertStaff({ displayName: 'Owner B', role: 'owner' });

    const response = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + token)
      .send({
        changes: {
          staff: [payload({
            id: ownerA.id,
            displayName: 'Owner A',
            role: 'owner',
            deletedAt: Date.now(),
            lastKnownSyncSeq: ownerA.syncSeq,
          })],
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.applied.deleted).toBe(1);
    const stored = await pg.pool.query('SELECT deleted_at FROM staff WHERE id = $1', [ownerA.id]);
    expect(stored.rows[0].deleted_at).not.toBeNull();
  });

  it('rejects arbitrary unknown fields instead of stripping them', async () => {
    const response = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', 'Bearer ' + token)
      .send({ changes: { staff: [payload({ unexpectedField: 'nope' })] } });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('Unknown staff field "unexpectedField" is not allowed through sync');
  });
});
