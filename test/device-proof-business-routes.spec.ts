import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import * as crypto from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET, createTestJwtService, signAgentToken } from './helpers/jwt.js';
import { CashSessionController } from '../src/cash-session.controller.js';
import { CashSessionService } from '../src/cash-session.service.js';
import { AttachmentController } from '../src/sync-attachment.controller.js';
import { AttachmentService } from '../src/sync-attachment.service.js';
import type { AttachmentStorage } from '../src/attachment-storage.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { DeviceApprovalGuard } from '../src/device-approval.guard.js';
import { DeviceProofGuard } from '../src/auth/device-proof.guard.js';
import { DeviceRepository } from '../src/devices/device.repository.js';
import { DeviceProofNonceRepository } from '../src/auth/device-proof-nonce.repository.js';

class TestStorage implements AttachmentStorage {
  readonly puts: string[] = [];
  async presignPut(key: string) { this.puts.push(key); return { url: 'https://storage.invalid/' + key, expiresIn: 900 }; }
  async presignGet(key: string) { return { url: 'https://storage.invalid/' + key, expiresIn: 3600 }; }
  async head() { return { exists: false }; }
  async delete() {}
  async listByPrefix() { return []; }
}

describe('Device proof on cash-session and attachment routes', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  const tenantId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const approvedDeviceId = crypto.randomUUID();
  const pendingDeviceId = crypto.randomUUID();
  const jwt = createTestJwtService();
  const token = signAgentToken(agentId, jwt, tenantId);
  const storage = new TestStorage();
  let privateKeyPem: string;
  let publicKeyPem: string;
  let checkInId: string;
  let cashSessionId: string;

  function proof(method: string, path: string, options: { deviceId?: string; privateKey?: string } = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      jti: crypto.randomUUID(), htm: method, htu: path,
      iat: Math.floor(Date.now() / 1000),
      ath: crypto.createHash('sha256').update(token).digest('base64url'),
    })).toString('base64url');
    const input = header + '.' + payload;
    const signature = crypto.sign('sha256', Buffer.from(input, 'ascii'), {
      key: options.privateKey ?? privateKeyPem, dsaEncoding: 'ieee-p1363',
    });
    return input + '.' + signature.toString('base64url');
  }

  function headers(deviceId = approvedDeviceId, signedProof?: string) {
    const h: Record<string, string> = {
      Authorization: 'Bearer ' + token,
      'X-Device-Id': deviceId,
    };
    if (signedProof) h['X-Device-Proof'] = signedProof;
    return h;
  }

  async function insertDevice(id: string, status: 'approved' | 'pending_approval', withCredential: boolean) {
    await pg.pool.query(
      `INSERT INTO public.devices
        (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active, approval_status)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, true, $6)`,
      [id, tenantId, crypto.randomUUID(), 'Proof test device', 'proof-' + id, status],
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
      controllers: [CashSessionController, AttachmentController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: CashSessionService, useFactory: (db: any) => new CashSessionService(db), inject: ['DRIZZLE_DB'] },
        { provide: AttachmentService, useFactory: (db: any) => new AttachmentService(db, storage), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard, DeviceApprovalGuard, DeviceProofGuard, DeviceRepository, DeviceProofNonceRepository,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    await app.init();
  });

  afterAll(async () => { await app?.close(); await pg?.stop(); });

  beforeEach(async () => {
    storage.puts.length = 0;
    await pg.pool.query('TRUNCATE sales, cash_sessions, staff, attachments, check_ins, missions, sites RESTART IDENTITY CASCADE');
    await pg.pool.query('ALTER SEQUENCE global_sync_seq RESTART WITH 1');
    const now = Date.now();
    const staffId = crypto.randomUUID();
    await pg.pool.query(
      `INSERT INTO staff (id, tenant_id, display_name, role, is_active, created_at, updated_at, sync_seq, first_sync_seq)
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

    const siteId = crypto.randomUUID(), missionId = crypto.randomUUID();
    checkInId = crypto.randomUUID();
    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)',
      [siteId, tenantId, 'Proof site', 48.85, 2.35],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionId, tenantId, agentId, 'Proof mission', siteId],
    );
    await pg.pool.query(
      `INSERT INTO check_ins
       (id, tenant_id, mission_id, agent_id, check_in_time, check_out_time, check_in_lat, check_in_lng, check_in_method, created_at, updated_at, deleted_at, sync_seq)
       VALUES ($1, $2, $3, $4, $5, NULL, 48.85, 2.35, 'GPS', $5, $5, NULL, nextval('global_sync_seq'))`,
      [checkInId, tenantId, missionId, agentId, now],
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

  it('rejects a proof signed for another cash-session UUID', async () => {
    const path = '/cash-sessions/' + cashSessionId + '/close';
    const response = await request(app.getHttpServer()).post(path)
      .set(headers(approvedDeviceId, proof('POST', '/cash-sessions/' + crypto.randomUUID() + '/close')))
      .send({ closingAmount: 10000 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HTM_HTU_MISMATCH');
    const state = await pg.pool.query('SELECT status FROM cash_sessions WHERE id = $1', [cashSessionId]);
    expect(state.rows[0].status).toBe('open');
  });

  it('rejects cash movement access from a pending terminal before business logic', async () => {
    // No movement route exists in this API contract yet; the close route is used
    // to prove that pending devices are rejected before the controller handler.
    const path = '/cash-sessions/' + cashSessionId + '/close';
    const response = await request(app.getHttpServer()).post(path)
      .set(headers(pendingDeviceId, proof('POST', path)))
      .send({ closingAmount: 10000 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEVICE_PENDING_APPROVAL');
  });

  it('rejects attachment upload authorization before creating a pending row or presigning', async () => {
    const response = await request(app.getHttpServer()).post('/attachments/request-upload')
      .set(headers(approvedDeviceId))
      .send({
        check_in_id: checkInId, content_type: 'image/jpeg',
        size_bytes: 1024, checksum_sha256: 'a'.repeat(64),
      });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('DEVICE_PROOF_MISSING');
    expect(storage.puts).toHaveLength(0);
    const rows = await pg.pool.query('SELECT id FROM attachments');
    expect(rows.rows).toHaveLength(0);
  });

  it('allows attachment URL issuance with a valid device proof', async () => {
    const path = '/attachments/request-upload';
    const response = await request(app.getHttpServer()).post(path)
      .set(headers(approvedDeviceId, proof('POST', path)))
      .send({
        check_in_id: checkInId, content_type: 'image/jpeg',
        size_bytes: 1024, checksum_sha256: 'a'.repeat(64),
      });
    expect(response.status).toBe(201);
    expect(storage.puts).toHaveLength(1);
  });

  it('protects attachment listing with a GET-bound device proof', async () => {
    const path = '/attachments';
    const response = await request(app.getHttpServer()).get(path + '?check_in_id=' + checkInId)
      .set(headers(approvedDeviceId, proof('GET', path)));
    expect(response.status).toBe(200);
  });
});
