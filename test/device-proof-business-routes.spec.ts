import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET, createTestJwtService, signAgentToken } from './helpers/jwt.js';
import { CashSessionController } from '../src/cash-session.controller.js';
import { CashSessionService } from '../src/cash-session.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { DeviceApprovalGuard } from '../src/device-approval.guard.js';
import { DeviceProofGuard } from '../src/auth/device-proof.guard.js';

const require = createRequire(import.meta.url);
const { createDeviceProof } = require('../electron-app/electron/auth/device-crypto.cjs') as {
  createDeviceProof(input: { privateKeyPem: string; token: string; method: string; url: string }): string;
};

describe('Device proof on POS cash-session route', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  const tenantId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const approvedDeviceId = crypto.randomUUID();
  const pendingDeviceId = crypto.randomUUID();
  const jwt = createTestJwtService();
  const token = signAgentToken(agentId, jwt, tenantId);
  let privateKeyPem: string;
  let publicKeyPem: string;
  let cashSessionId: string;

  function proof(method: string, path: string, privateKey = privateKeyPem) {
    return createDeviceProof({
      privateKeyPem: privateKey,
      token,
      method,
      url: 'https://sync.example.test' + path,
    });
  }

  function headers(deviceId = approvedDeviceId, signedProof?: string) {
    const value: Record<string, string> = {
      Authorization: 'Bearer ' + token,
      'X-Device-Id': deviceId,
    };
    if (signedProof) value['X-Device-Proof'] = signedProof;
    return value;
  }

  async function insertDevice(id: string, status: 'approved' | 'pending_approval', withCredential: boolean) {
    await pg.pool.query(
      `INSERT INTO public.devices
        (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active,
         approval_status, approved_at, approved_by)
       VALUES (
         $1, $2, $3, 'Proof test device', $4, '{}'::jsonb, true, $5,
         CASE WHEN $5 = 'approved' THEN now() ELSE NULL END,
         CASE WHEN $5 = 'approved' THEN $6::uuid ELSE NULL END
       )`,
      [id, tenantId, crypto.randomUUID(), 'proof-' + id, status, agentId],
    );
    if (withCredential) {
      await pg.pool.query(
        `INSERT INTO public.device_credentials
          (id, tenant_id, device_id, public_key_pem, key_thumbprint, algorithm, status)
         VALUES ($1, $2, $3, $4, $5, 'ES256', 'active')`,
        [crypto.randomUUID(), tenantId, id, publicKeyPem, 'thumb-' + id],
      );
    }
  }

  beforeAll(async () => {
    pg = await startTestPostgres();
    const pair = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKeyPem = pair.privateKey;
    publicKeyPem = pair.publicKey;
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
    await insertDevice(approvedDeviceId, 'approved', true);
    await insertDevice(pendingDeviceId, 'pending_approval', false);

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '30d' } })],
      controllers: [CashSessionController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: CashSessionService, useFactory: (db: any) => new CashSessionService(db), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
        DeviceApprovalGuard,
        DeviceProofGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.pool.query('TRUNCATE sales, cash_sessions, staff RESTART IDENTITY CASCADE');
    await pg.pool.query('ALTER SEQUENCE global_sync_seq RESTART WITH 1');
    const now = Date.now();
    const staffId = crypto.randomUUID();
    await pg.pool.query(
      `INSERT INTO staff
        (id, tenant_id, display_name, role, is_active, created_at, updated_at, sync_seq, first_sync_seq)
       VALUES ($1, $2, 'Cashier', 'cashier', true, $3, $3, nextval('global_sync_seq'), nextval('global_sync_seq'))`,
      [staffId, tenantId, now],
    );
    cashSessionId = crypto.randomUUID();
    await pg.pool.query(
      `INSERT INTO cash_sessions
       (id, tenant_id, staff_id, terminal_label, opened_at, opening_amount, status, created_at, updated_at, sync_seq, first_sync_seq)
       VALUES ($1, $2, $3, 'Till 1', $4, 10000, 'open', $4, $4, nextval('global_sync_seq'), nextval('global_sync_seq'))`,
      [cashSessionId, tenantId, staffId, now],
    );
  });

  it('closes a cash session only with a proof bound to its concrete UUID path', async () => {
    const path = '/cash-sessions/' + cashSessionId + '/close';
    const response = await request(app.getHttpServer()).post(path)
      .set(headers(approvedDeviceId, proof('POST', path)))
      .send({ closingAmount: 10000 });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('closed');
  });

  it('rejects a proof signed for another cash-session UUID without changing the session', async () => {
    const path = '/cash-sessions/' + cashSessionId + '/close';
    const response = await request(app.getHttpServer()).post(path)
      .set(headers(approvedDeviceId, proof('POST', '/cash-sessions/' + crypto.randomUUID() + '/close')))
      .send({ closingAmount: 10000 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HTM_HTU_MISMATCH');
    const state = await pg.pool.query('SELECT status FROM cash_sessions WHERE id = $1', [cashSessionId]);
    expect(state.rows[0].status).toBe('open');
  });

  it('rejects a pending terminal before cash-session business logic', async () => {
    const path = '/cash-sessions/' + cashSessionId + '/close';
    const response = await request(app.getHttpServer()).post(path)
      .set(headers(pendingDeviceId, proof('POST', path)))
      .send({ closingAmount: 10000 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEVICE_PENDING_APPROVAL');
    const state = await pg.pool.query('SELECT status FROM cash_sessions WHERE id = $1', [cashSessionId]);
    expect(state.rows[0].status).toBe('open');
  });

  it('rejects missing proof before cash-session business logic', async () => {
    const path = '/cash-sessions/' + cashSessionId + '/close';
    const response = await request(app.getHttpServer()).post(path)
      .set(headers(approvedDeviceId))
      .send({ closingAmount: 10000 });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('DEVICE_PROOF_MISSING');
    const state = await pg.pool.query('SELECT status FROM cash_sessions WHERE id = $1', [cashSessionId]);
    expect(state.rows[0].status).toBe('open');
  });
});
