import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { DeviceStatusController } from '../src/device-status.controller.js';
import { DeviceStatusService } from '../src/device-status.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { TEST_JWT_SECRET, createTestJwtService, signAgentToken } from './helpers/jwt.js';

describe('GET /api/v1/devices/status', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let jwt: JwtService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentA = randomUUID();
  const pendingId = randomUUID();
  const approvedId = randomUUID();
  const rejectedId = randomUUID();
  const revokedId = randomUUID();
  const inactiveId = randomUUID();
  const foreignId = randomUUID();
  let tokenA: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    jwt = createTestJwtService();
    tokenA = signAgentToken(agentA, jwt, tenantA);

    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2), ($3, $2) ON CONFLICT (id) DO NOTHING',
      [tenantA, Date.now(), tenantB],
    );
    await pg.pool.query(
      `INSERT INTO devices
        (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active, approval_status, approved_at, approved_by)
       VALUES
        ($1, $2, $7, 'Pending', $8, '{}', true, 'pending_approval', NULL, NULL),
        ($3, $2, $7, 'Approved', $9, '{}', true, 'approved', now(), $10),
        ($4, $2, $7, 'Rejected', $11, '{}', true, 'rejected', NULL, NULL),
        ($5, $2, $7, 'Revoked', $12, '{}', true, 'revoked', now(), $10),
        ($6, $2, $7, 'Inactive', $13, '{}', false, 'approved', now(), $10),
        ($14, $15, $7, 'Foreign', $16, '{}', true, 'approved', now(), $10)`,
      [
        pendingId, tenantA, approvedId, rejectedId, revokedId, inactiveId,
        randomUUID(), 'fingerprint-' + pendingId, 'fingerprint-' + approvedId,
        agentA, 'fingerprint-' + rejectedId, 'fingerprint-' + revokedId,
        'fingerprint-' + inactiveId, foreignId, tenantB, 'fingerprint-' + foreignId,
      ],
    );
    await pg.pool.query(
      `INSERT INTO device_credentials (tenant_id, device_id, public_key_pem, key_thumbprint)
       VALUES ($1, $2, 'public-key-approved', 'thumbprint-approved')`,
      [tenantA, approvedId],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({
        secret: TEST_JWT_SECRET,
        signOptions: { expiresIn: '30d' },
      })],
      controllers: [DeviceStatusController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: DeviceStatusService, useFactory: (d: any) => new DeviceStatusService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
  });

  it('returns pending approval without requiring DeviceApprovalGuard or ES256 proof', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA)
      .set('X-Device-Id', pendingId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      deviceId: pendingId,
      tenantId: tenantA,
      approvalStatus: 'pending_approval',
      isActive: true,
      hasActiveCredential: false,
    });
  });

  it('returns approved only as server state and reports active credential readiness separately', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA)
      .set('X-Device-Id', approvedId);

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('approved');
    expect(response.body.isActive).toBe(true);
    expect(response.body.hasActiveCredential).toBe(true);
  });

  it.each([
    [rejectedId, 'rejected'],
    [revokedId, 'revoked'],
  ])('returns the explicit %s state', async (deviceId, approvalStatus) => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA)
      .set('X-Device-Id', deviceId);

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe(approvalStatus);
  });

  it('reports inactive devices separately from their approval status', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA)
      .set('X-Device-Id', inactiveId);

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('approved');
    expect(response.body.isActive).toBe(false);
  });

  it('does not reveal a device belonging to another tenant', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA)
      .set('X-Device-Id', foreignId);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('requires an authenticated agent and a device identity', async () => {
    const noToken = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('X-Device-Id', pendingId);
    expect(noToken.status).toBe(401);

    const noDevice = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA);
    expect(noDevice.status).toBe(401);
    expect(noDevice.body.code).toBe('DEVICE_IDENTITY_MISSING');
  });
});
