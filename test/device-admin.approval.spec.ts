import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import * as crypto from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { assertDeviceAdminDatabaseIdentity } from '../src/device-admin-db-guard.js';
import { TEST_JWT_SECRET } from './helpers/jwt.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { DeviceAdminController } from '../src/device-admin.controller.js';
import { DeviceAdminService } from '../src/device-admin.service.js';
import { DeviceAdminPermissionGuard } from '../src/device-admin.guard.js';

describe('Device administration approval workflow', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let jwt: JwtService;
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const actorA = crypto.randomUUID();
  const pendingA = crypto.randomUUID();
  const pendingReject = crypto.randomUUID();
  const pendingB = crypto.randomUUID();
  const approvedA = crypto.randomUUID();

  async function token(tenantId: string, agentId: string, permissions: string[] = []) {
    return jwt.signAsync({ sub: agentId, tenantId, permissions });
  }

  async function insertDevice(
    id: string,
    tenantId: string,
    status: 'pending_approval' | 'approved',
    withCredential = false,
  ) {
    await pg.pool.query(
      `INSERT INTO public.devices
        (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active,
         approval_status, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, true, $6,
         CASE WHEN $6 = 'approved' THEN now() ELSE NULL END,
         CASE WHEN $6 = 'approved' THEN $7::uuid ELSE NULL END)`,
      [id, tenantId, crypto.randomUUID(), 'Admin test device ' + id, 'admin-' + id, status, actorA],
    );
    if (withCredential) {
      await pg.pool.query(
        `INSERT INTO public.device_credentials
          (id, tenant_id, device_id, public_key_pem, key_thumbprint, algorithm, status)
         VALUES ($1, $2, $3, 'test-public-key', $4, 'ES256', 'active')`,
        [crypto.randomUUID(), tenantId, id, 'thumb-' + id],
      );
    }
  }

  beforeAll(async () => {
    pg = await startTestPostgres();
    await assertDeviceAdminDatabaseIdentity(pg.adminPool);

    await pg.pool.query(
      'INSERT INTO public.tenants (id, first_seen_at) VALUES ($1, $3), ($2, $3) ON CONFLICT (id) DO NOTHING',
      [tenantA, tenantB, Date.now()],
    );
    await insertDevice(pendingA, tenantA, 'pending_approval');
    await insertDevice(pendingReject, tenantA, 'pending_approval');
    await insertDevice(pendingB, tenantB, 'pending_approval');
    await insertDevice(approvedA, tenantA, 'approved', true);

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '30d' } })],
      controllers: [DeviceAdminController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: 'DEVICE_ADMIN_DB', useValue: pg.adminDb },
        { provide: DeviceAdminService, useFactory: (db: any, adminDb: any) => new DeviceAdminService(db, adminDb), inject: ['DRIZZLE_DB', 'DEVICE_ADMIN_DB'] },
        JwtAuthGuard,
        DeviceAdminPermissionGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    jwt = moduleRef.get(JwtService);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('requires a verified JWT and the exact permission for each operation', async () => {
    const noPermission = await token(tenantA, actorA);
    const denied = await request(app.getHttpServer())
      .get('/api/v1/admin/devices/pending')
      .set('Authorization', 'Bearer ' + noPermission);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('DEVICE_ADMIN_PERMISSION_REQUIRED');

    const noToken = await request(app.getHttpServer()).get('/api/v1/admin/devices/pending');
    expect(noToken.status).toBe(401);

    const wrongPermission = await token(tenantA, actorA, ['devices:approve']);
    const approveDenied = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + pendingA + '/reject')
      .set('Authorization', 'Bearer ' + wrongPermission)
      .send({ reason: 'Not authorized for rejection' });
    expect(approveDenied.status).toBe(403);
  });

  it('lists only pending devices from the authenticated tenant', async () => {
    const auth = await token(tenantA, actorA, ['devices:read']);
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/devices/pending')
      .set('Authorization', 'Bearer ' + auth);
    expect(response.status).toBe(200);
    expect(response.body.map((device: { id: string }) => device.id)).toContain(pendingA);
    expect(response.body.map((device: { id: string }) => device.id)).toContain(pendingReject);
    expect(response.body.map((device: { id: string }) => device.id)).not.toContain(pendingB);
    expect(response.body.map((device: { id: string }) => device.id)).not.toContain(approvedA);
  });

  it('approves a pending device and appends the decision event atomically', async () => {
    const auth = await token(tenantA, actorA, ['devices:approve']);
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + pendingA + '/approve')
      .set('Authorization', 'Bearer ' + auth);
    expect(response.status).toBe(201);
    expect(response.body.approvalStatus).toBe('approved');
    expect(response.body.approvedBy).toBe(actorA);

    const event = await pg.pool.query(
      `SELECT event_type, from_status, to_status, actor_id
         FROM public.device_approval_events
        WHERE tenant_id = $1 AND device_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenantA, pendingA],
    );
    expect(event.rows[0]).toEqual({
      event_type: 'approved',
      from_status: 'pending_approval',
      to_status: 'approved',
      actor_id: actorA,
    });
  });

  it('rejects a duplicate approval without appending a second decision', async () => {
    const auth = await token(tenantA, actorA, ['devices:approve']);
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + pendingA + '/approve')
      .set('Authorization', 'Bearer ' + auth);
    expect(response.status).toBe(409);

    const events = await pg.pool.query(
      `SELECT count(*)::int AS count
         FROM public.device_approval_events
        WHERE tenant_id = $1 AND device_id = $2 AND event_type = 'approved'`,
      [tenantA, pendingA],
    );
    expect(events.rows[0].count).toBe(1);
  });

  it('rejects only pending devices and requires an audit reason', async () => {
    const auth = await token(tenantA, actorA, ['devices:reject']);
    const missingReason = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + pendingReject + '/reject')
      .set('Authorization', 'Bearer ' + auth)
      .send({});
    expect(missingReason.status).toBe(400);

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + pendingReject + '/reject')
      .set('Authorization', 'Bearer ' + auth)
      .send({ reason: 'Dossier de terminal incomplet' });
    expect(response.status).toBe(201);
    expect(response.body.approvalStatus).toBe('rejected');
    expect(response.body.approvedAt).toBeNull();
    expect(response.body.approvedBy).toBeNull();
  });

  it('revokes an approved device and its active credential in the same transaction', async () => {
    const auth = await token(tenantA, actorA, ['devices:revoke']);
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + approvedA + '/revoke')
      .set('Authorization', 'Bearer ' + auth)
      .send({ reason: 'Terminal déclaré perdu' });
    expect(response.status).toBe(201);
    expect(response.body.approvalStatus).toBe('revoked');

    const credential = await pg.pool.query(
      'SELECT status, revoked_at FROM public.device_credentials WHERE tenant_id = $1 AND device_id = $2',
      [tenantA, approvedA],
    );
    expect(credential.rows[0].status).toBe('revoked');
    expect(credential.rows[0].revoked_at).not.toBeNull();
  });

  it('cannot approve a device belonging to another tenant', async () => {
    const auth = await token(tenantA, actorA, ['devices:approve']);
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + pendingB + '/approve')
      .set('Authorization', 'Bearer ' + auth);
    expect(response.status).toBe(404);

    const state = await pg.pool.query(
      'SELECT approval_status FROM public.devices WHERE tenant_id = $1 AND id = $2',
      [tenantB, pendingB],
    );
    expect(state.rows[0].approval_status).toBe('pending_approval');
  });

  it('keeps the admin capability isolated from direct table access and sync_app', async () => {
    await expect(pg.adminPool.query('SELECT id FROM public.devices LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    await expect(pg.appPool.query(
      'SELECT * FROM public.transition_device_approval($1, $2, $3, $4, $5)',
      [tenantA, pendingReject, actorA, 'approve', null],
    )).rejects.toMatchObject({ code: '42501' });
  });
});
