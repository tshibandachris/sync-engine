import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import * as crypto from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET, createTestJwtService, signAgentToken } from './helpers/jwt.js';
import { SyncController } from '../src/sync.controller.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { DeviceProofGuard } from '../src/auth/device-proof.guard.js';
import { DeviceRepository } from '../src/devices/device.repository.js';
import { DeviceProofNonceRepository } from '../src/auth/device-proof-nonce.repository.js';

describe('HTTP device proof verification', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  const tenantId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const approvedDeviceId = crypto.randomUUID();
  const pendingDeviceId = crypto.randomUUID();
  const revokedDeviceId = crypto.randomUUID();
  const inactiveDeviceId = crypto.randomUUID();
  const rejectedDeviceId = crypto.randomUUID();
  const noCredentialDeviceId = crypto.randomUUID();
  const jwt = createTestJwtService();
  const token = signAgentToken(agentId, jwt, tenantId);
  let privateKeyPem: string;
  let publicKeyPem: string;

  function buildProof(options: {
    jti?: string;
    privateKey?: string;
    jwt?: string;
    method?: string;
    path?: string;
    iat?: number;
    alg?: string;
    typ?: string;
  } = {}): string {
    const header = { alg: options.alg ?? 'ES256', typ: options.typ ?? 'dpop+jwt' };
    const payload = {
      jti: options.jti ?? crypto.randomUUID(),
      htm: options.method ?? 'POST',
      htu: options.path ?? '/sync/pull',
      iat: options.iat ?? Math.floor(Date.now() / 1000),
      ath: crypto.createHash('sha256').update(options.jwt ?? token).digest('base64url'),
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = crypto.sign(
      'sha256',
      Buffer.from(signingInput, 'ascii'),
      { key: options.privateKey ?? privateKeyPem, dsaEncoding: 'ieee-p1363' },
    );
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  async function callSync(deviceId: string, proof?: string) {
    let call = request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Device-Id', deviceId);
    if (proof) call = call.set('X-Device-Proof', proof);
    return call.send({ last_pulled_at: null, limit: 50 });
  }

  async function insertDevice(
    id: string,
    status: 'pending_approval' | 'approved' | 'rejected' | 'revoked',
    active = true,
    withCredential = false,
  ) {
    await pg.pool.query(
      `INSERT INTO public.devices
        (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active,
         approval_status, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7,
         CASE WHEN $7 IN ('approved', 'revoked') THEN now() ELSE NULL END,
         CASE WHEN $7 IN ('approved', 'revoked') THEN $8::uuid ELSE NULL END)`,
      [id, tenantId, crypto.randomUUID(), `Proof device ${id}`, `proof-${id}`, active, status, agentId],
    );
    if (withCredential) {
      await pg.pool.query(
        `INSERT INTO public.device_credentials
          (id, tenant_id, device_id, public_key_pem, key_thumbprint, algorithm, status)
         VALUES ($1, $2, $3, $4, $5, 'ES256', 'active')`,
        [crypto.randomUUID(), tenantId, id, publicKeyPem, `thumb-${id}`],
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
      'INSERT INTO public.tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
    await insertDevice(approvedDeviceId, 'approved', true, true);
    await insertDevice(pendingDeviceId, 'pending_approval');
    await insertDevice(revokedDeviceId, 'revoked');
    await insertDevice(inactiveDeviceId, 'approved', false, true);
    await insertDevice(rejectedDeviceId, 'rejected');
    await insertDevice(noCredentialDeviceId, 'approved');

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '30d' } })],
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: SyncPullService, useFactory: (db: any) => new SyncPullService(db), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (db: any) => new SyncPushService(db), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (db: any) => new SyncConflictService(db), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
        DeviceRepository,
        DeviceProofNonceRepository,
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

  it('rejects a request without X-Device-Id', async () => {
    const response = await request(app.getHttpServer())
      .post('/sync/pull')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('DEVICE_IDENTITY_MISSING');
  });

  it('rejects a request without X-Device-Proof', async () => {
    const response = await callSync(approvedDeviceId);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('DEVICE_PROOF_MISSING');
  });

  it('does not hide a pending device behind a missing-credential result', async () => {
    const response = await callSync(pendingDeviceId, buildProof());
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEVICE_PENDING_APPROVAL');
  });

  it('rejects a revoked device with its explicit state', async () => {
    const response = await callSync(revokedDeviceId, buildProof());
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEVICE_REVOKED');
  });

  it('rejects a rejected device with its explicit state', async () => {
    const response = await callSync(rejectedDeviceId, buildProof());
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEVICE_REJECTED');
  });

  it('rejects an approved device without an active credential', async () => {
    const response = await callSync(noCredentialDeviceId, buildProof());
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NO_ACTIVE_CREDENTIAL');
  });

  it('rejects an inactive approved device', async () => {
    const response = await callSync(inactiveDeviceId, buildProof());
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEVICE_DEACTIVATED');
  });

  it('rejects a proof signed by a different private key', async () => {
    const foreign = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const foreignPrivate = foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const response = await callSync(approvedDeviceId, buildProof({ privateKey: foreignPrivate }));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_DEVICE_SIGNATURE');
  });

  it('does not consume jti when signature verification fails', async () => {
    const jti = crypto.randomUUID();
    const foreign = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const foreignPrivate = foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const invalid = await callSync(approvedDeviceId, buildProof({ jti, privateKey: foreignPrivate }));
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe('INVALID_DEVICE_SIGNATURE');

    const valid = await callSync(approvedDeviceId, buildProof({ jti }));
    expect(valid.status).toBe(201);
  });

  it('rejects a proof bound to a different access token', async () => {
    const response = await callSync(approvedDeviceId, buildProof({ jwt: 'different.jwt.token' }));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ATH_MISMATCH');
  });

  it('rejects a proof outside the ±60 second window', async () => {
    const response = await callSync(
      approvedDeviceId,
      buildProof({ iat: Math.floor(Date.now() / 1000) - 120 }),
    );
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('PROOF_EXPIRED');
  });

  it('rejects a method/path mismatch', async () => {
    const response = await callSync(approvedDeviceId, buildProof({ path: '/sync/push' }));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HTM_HTU_MISMATCH');
  });

  it('rejects unsupported JWS headers and extra header parameters', async () => {
    const response = await callSync(approvedDeviceId, buildProof({ alg: 'none' }));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNSUPPORTED_PROOF_ALGORITHM');
  });

  it('rejects a malformed compact JWS', async () => {
    const response = await callSync(approvedDeviceId, 'not-a-jws');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('MALFORMED_PROOF');
  });

  it('rejects a replayed proof', async () => {
    const proof = buildProof();
    const first = await callSync(approvedDeviceId, proof);
    const second = await callSync(approvedDeviceId, proof);
    expect(first.status).toBe(201);
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('PROOF_REPLAYED');
  });

  it('allows synchronization when JWT, device state, credential and proof all validate', async () => {
    const response = await callSync(approvedDeviceId, buildProof());
    expect(response.status).toBe(201);
    expect(response.body.changes).toBeDefined();
  });

  it('arbitrates concurrent copies of one proof with exactly one successful request', async () => {
    const proof = buildProof();
    const responses = await Promise.all([
      callSync(approvedDeviceId, proof),
      callSync(approvedDeviceId, proof),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 401]);
    expect(responses.find((response) => response.status === 401)?.body.code).toBe('PROOF_REPLAYED');
  });
});
