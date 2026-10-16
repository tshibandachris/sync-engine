import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import * as schema from '../src/schema.js';
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

describe('Staff pull / HTTP security', () => {
  let pg: TestPostgres;
  let db: NodePgDatabase<typeof schema>;
  let app: INestApplication;
  let jwt: JwtService;
  let tokenA: string;
  let tokenB: string;

  const agentA = randomUUID();
  const tenantA = TEST_TENANT_ID;
  const tenantB = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    db = drizzle(pg.appPool, { schema });
    jwt = createTestJwtService();
    tokenA = signAgentToken(agentA, jwt, tenantA);
    tokenB = signAgentToken(randomUUID(), jwt, tenantB);

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
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $3), ($2, $3) ON CONFLICT (id) DO NOTHING',
      [tenantA, tenantB, Date.now()],
    );
  });

  async function insertStaff(input: {
    id: string;
    tenantId: string;
    displayName: string;
    role: 'owner' | 'manager' | 'cashier';
    isActive: boolean;
    deletedAt?: number | null;
    pinHash: string;
    pinAlgo: 'bcrypt' | 'argon2id';
    authSubject: string;
  }) {
    await pg.pool.query(
      `INSERT INTO staff
        (id, tenant_id, display_name, role, pin_hash, pin_algo, auth_subject,
         is_active, created_at, updated_at, deleted_at, sync_seq, first_sync_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, nextval('global_sync_seq'), nextval('global_sync_seq'))`,
      [
        input.id, input.tenantId, input.displayName, input.role, input.pinHash,
        input.pinAlgo, input.authSubject, input.isActive, Date.now(), input.deletedAt ?? null,
      ],
    );
  }

  it('returns only safe staff fields and never serializes credential material', async () => {
    const activeId = randomUUID();
    const deletedId = randomUUID();
    const otherTenantId = randomUUID();

    await insertStaff({
      id: activeId,
      tenantId: tenantA,
      displayName: 'Staff A',
      role: 'manager',
      isActive: true,
      pinHash: '$2b$12$must-never-leak-this-hash',
      pinAlgo: 'bcrypt',
      authSubject: randomUUID(),
    });
    await insertStaff({
      id: deletedId,
      tenantId: tenantA,
      displayName: 'Deleted Staff A',
      role: 'cashier',
      isActive: false,
      deletedAt: Date.now(),
      pinHash: '$argon2id$v=19$must-never-leak-this-hash',
      pinAlgo: 'argon2id',
      authSubject: randomUUID(),
    });
    await insertStaff({
      id: otherTenantId,
      tenantId: tenantB,
      displayName: 'Staff B must not appear',
      role: 'owner',
      isActive: true,
      pinHash: '$2y$12$other-tenant-secret',
      pinAlgo: 'bcrypt',
      authSubject: randomUUID(),
    });

    // The body must not be able to override the tenant bound to tokenA.
    const response = await request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ last_pulled_at: 0, limit: 100, tenantId: tenantB });

    expect(response.status).toBe(201);
    expect(response.text).toContain('Staff A');
    expect(response.text).toContain('Deleted Staff A');
    expect(response.text).not.toContain('Staff B must not appear');

    // Inspect raw serialized HTTP text, not only the parsed object.
    expect(response.text).not.toMatch(/pinHash|pin_hash|pinAlgo|pin_algo|authSubject|auth_subject/i);
    expect(response.text).not.toMatch(/\$2a\$|\$2b\$|\$2y\$|\$argon2/i);

    expect(response.body.changes.staff.created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: activeId,
          displayName: 'Staff A',
          role: 'manager',
          isActive: true,
        }),
      ]),
    );
    expect(response.body.changes.staff.deleted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deletedId,
          displayName: 'Deleted Staff A',
          role: 'cashier',
          isActive: false,
        }),
      ]),
    );
    expect(JSON.stringify(response.body)).not.toContain(otherTenantId);
  });

  it('uses the tenant from the JWT rather than a tenantId supplied in the body', async () => {
    const onlyA = randomUUID();
    await insertStaff({
      id: onlyA,
      tenantId: tenantA,
      displayName: 'Tenant A Staff',
      role: 'cashier',
      isActive: true,
      pinHash: '$2b$12$hash-a',
      pinAlgo: 'bcrypt',
      authSubject: randomUUID(),
    });

    const response = await request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ last_pulled_at: 0, limit: 100, tenantId: tenantA });

    expect(response.status).toBe(201);
    expect(response.text).not.toContain('Tenant A Staff');
    expect(response.body.changes.staff.created).toEqual([]);
    expect(response.body.changes.staff.updated).toEqual([]);
    expect(response.body.changes.staff.deleted).toEqual([]);
  });
});
