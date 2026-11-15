import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/main.js';
import type { AttachmentStorage } from '../src/attachment-storage.js';
import { assertEnrollmentDatabaseIdentity } from '../src/device-enrollment-db-guard.js';
import { assertDeviceAdminDatabaseIdentity } from '../src/device-admin-db-guard.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

const require = createRequire(import.meta.url);
const { DeviceStatusService } = require('../electron-app/electron/auth/device-status.cjs') as {
  DeviceStatusService: new (input: {
    baseUrl: string;
    getAgentToken: () => string;
    getDeviceId: () => string;
    getTenantId: () => string;
    getPrivateKeyPem: () => string;
  }) => { checkStatus(): Promise<Record<string, unknown>> };
};

const ISSUER = 'https://idp.test';
const AUDIENCE = 'eden-sync';
const KEY_ID = 'eden-e2e-es256';
const TEST_JWT_SECRET = 'test-only-jwt-module-secret-not-used-for-idp-verification';

const E2E_ENV_KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'JWKS_URL',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'REDIS_URL',
] as const;

type EnvSnapshot = Map<(typeof E2E_ENV_KEYS)[number], { existed: boolean; value?: string }>;

function captureEnv(keys: readonly (typeof E2E_ENV_KEYS)[number][]): EnvSnapshot {
  return new Map(keys.map((key) => [key, {
    existed: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, entry] of snapshot) {
    if (entry.existed) process.env[key] = entry.value!;
    else delete process.env[key];
  }
}

type EnrolledDevice = {
  deviceId: string;
  tenantId: string;
  privateKeyPem: string;
  fingerprint: string;
};

describe('Eden Gestion E2E — real PostgreSQL, NestJS API, OIDC JWKS and ES256 device proof', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let idpServer: Server | undefined;
  let idpBaseUrl = '';
  let apiBaseUrl = '';
  let idpPrivateKey: CryptoKey;
  let jwksDocument: { keys: Record<string, unknown>[] };
  let initialCounts = { devices: -1, sync_conflicts: -1, sync_logs: -1 };
  let originalEnvSnapshot: EnvSnapshot | undefined;

  const tenantId = randomUUID();
  const agentId = randomUUID();
  const storeId = randomUUID();
  const adminActorId = randomUUID();

  const storage: AttachmentStorage = {
    async delete() {},
    async listByPrefix() { return []; },
    async presignPut() { return { url: 'https://storage.test/unused-put', expiresIn: 60 }; },
    async presignGet() { return { url: 'https://storage.test/unused-get', expiresIn: 60 }; },
    async head() { return { exists: false }; },
  };

  async function startOidcProvider() {
    const pair = await generateKeyPair('ES256', { extractable: true });
    idpPrivateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    jwksDocument = {
      keys: [{ ...publicJwk, kid: KEY_ID, alg: 'ES256', use: 'sig' }],
    };

    idpServer = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200);
        res.end(JSON.stringify({
          issuer: ISSUER,
          jwks_uri: idpBaseUrl ? `${idpBaseUrl}/jwks.json` : '',
          id_token_signing_alg_values_supported: ['ES256'],
        }));
        return;
      }
      if (req.url === '/jwks.json') {
        res.writeHead(200);
        res.end(JSON.stringify(jwksDocument));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await new Promise<void>((resolve, reject) => {
      idpServer!.once('error', reject);
      idpServer!.listen(0, '127.0.0.1', resolve);
    });
    const address = idpServer.address() as AddressInfo;
    idpBaseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function signAgentToken(permissions: string[] = []) {
    return new SignJWT({
      agent_id: agentId,
      tenantId,
      permissions,
    })
      .setProtectedHeader({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(agentId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(idpPrivateKey);
  }

  async function createPairingCode() {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase();
    const activationCode = `E2E1-${suffix}`;
    const codeHash = createHash('sha256').update(activationCode, 'utf8').digest('hex');
    await pg.pool.query(
      `INSERT INTO public.device_pairing_codes
        (tenant_id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [tenantId, storeId, codeHash, adminActorId],
    );
    return activationCode;
  }

  async function enrollDevice(): Promise<EnrolledDevice> {
    const activationCode = await createPairingCode();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const fingerprint = `fp-test-${suffix}`;
    const pair = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const publicKeyPem = pair.publicKey;
    const privateKeyPem = pair.privateKey;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      jti: randomUUID(),
      htm: 'POST',
      htu: '/api/v1/devices/enroll',
      iat: Math.floor(Date.now() / 1000),
      code_hash: createHash('sha256').update(activationCode, 'utf8').digest('base64url'),
      fingerprint,
    })).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: privateKeyPem,
      dsaEncoding: 'ieee-p1363',
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/devices/enroll')
      .set('X-Device-Fingerprint', fingerprint)
      .send({
        activationCode,
        deviceName: 'POS-KIN-001',
        hardwareInfo: {
          hostname: 'pos-kin-001',
          platform: 'linux',
          arch: 'x64',
          osRelease: 'e2e',
        },
        publicKeyPem,
        initialProof: `${signingInput}.${signature.toString('base64url')}`,
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.tenantId).toBe(tenantId);
    expect(response.body.data.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
    return {
      deviceId: response.body.data.deviceId,
      tenantId: response.body.data.tenantId,
      privateKeyPem,
      fingerprint,
    };
  }

  async function readServerStatus(device: EnrolledDevice) {
    const token = await signAgentToken();
    const client = new DeviceStatusService({
      baseUrl: apiBaseUrl,
      getAgentToken: () => token,
      getDeviceId: () => device.deviceId,
      getTenantId: () => device.tenantId,
      getPrivateKeyPem: () => device.privateKeyPem,
    });
    return client.checkStatus();
  }

  async function adminAction(deviceId: string, action: 'approve' | 'reject' | 'revoke', reason?: string) {
    const permission = action === 'approve' ? 'devices:approve'
      : action === 'reject' ? 'devices:reject' : 'devices:revoke';
    const token = await signAgentToken([permission]);
    const call = request(app.getHttpServer())
      .post(`/api/v1/admin/devices/${deviceId}/${action}`)
      .set('Authorization', `Bearer ${token}`);
    return reason ? call.send({ reason }) : call;
  }

  beforeAll(async () => {
      originalEnvSnapshot = captureEnv(E2E_ENV_KEYS);
      try {
        pg = await startTestPostgres();
      await assertEnrollmentDatabaseIdentity(pg.enrollmentPool);
      await assertDeviceAdminDatabaseIdentity(pg.adminPool);

      const counts = await pg.pool.query(`
        SELECT
          (SELECT count(*)::int FROM public.devices) AS devices,
          (SELECT count(*)::int FROM public.sync_conflicts) AS sync_conflicts,
          (SELECT count(*)::int FROM public.sync_logs) AS sync_logs
      `);
      initialCounts = counts.rows[0];

      await pg.pool.query(
        'INSERT INTO public.tenants (id, first_seen_at) VALUES ($1, $2)',
        [tenantId, Date.now()],
      );

      await startOidcProvider();
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.JWKS_URL = `${idpBaseUrl}/jwks.json`;
      process.env.JWT_ISSUER = ISSUER;
      process.env.JWT_AUDIENCE = AUDIENCE;
      process.env.REDIS_URL = '';

      app = await createApp(
        pg.appDb as any,
        pg.enrollmentDb as any,
        pg.adminDb as any,
        TEST_JWT_SECRET,
        storage,
      ) as unknown as INestApplication;
      await app.listen(0, '127.0.0.1');
      apiBaseUrl = await app.getUrl();
    } catch (error) {
      restoreEnv(originalEnvSnapshot);
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
      if (idpServer?.listening) {
        await new Promise<void>((resolve) => idpServer!.close(() => resolve()));
      }
      await pg?.stop();
    } finally {
      if (originalEnvSnapshot) {
        restoreEnv(originalEnvSnapshot);
        expect(captureEnv(E2E_ENV_KEYS)).toEqual(originalEnvSnapshot);
      }
    }
  });

  it('F-01 — starts from an empty PostgreSQL schema after the production migration runner', () => {
    expect(initialCounts).toEqual({ devices: 0, sync_conflicts: 0, sync_logs: 0 });
  });

  it('F-02 — exposes OIDC discovery and asymmetric JWKS endpoints', async () => {
    const discovery = await fetch(`${idpBaseUrl}/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as { issuer: string; jwks_uri: string };
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.jwks_uri).toBe(`${idpBaseUrl}/jwks.json`);

    const jwks = await fetch(metadata.jwks_uri);
    expect(jwks.status).toBe(200);
    const body = await jwks.json() as { keys: Array<{ kid: string; alg: string; kty: string }> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kid: KEY_ID, alg: 'ES256', kty: 'EC' });
  });

  it('F-03 — runs the real NestJS API with JWT/JWKS verification and ES256 device proof', async () => {
    const device = await enrollDevice();
    const pending = await readServerStatus(device);
    expect(pending).toMatchObject({ success: true, tenantId, approvalStatus: 'pending_approval' });

    const approved = await adminAction(device.deviceId, 'approve');
    expect(approved.status).toBe(201);
    expect(approved.body.approvalStatus).toBe('approved');

    const status = await readServerStatus(device);
    expect(status).toMatchObject({ success: true, tenantId, approvalStatus: 'approved' });

    const audit = await pg.pool.query(
      `SELECT event_type, from_status, to_status, actor_id
         FROM public.device_approval_events
        WHERE tenant_id = $1 AND device_id = $2
        ORDER BY created_at ASC, id ASC`,
      [tenantId, device.deviceId],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(['requested', 'approved']);
    expect(audit.rows[1]).toMatchObject({
      from_status: 'pending_approval',
      to_status: 'approved',
      actor_id: agentId,
    });
  }, 120_000);

  it('E2E-04 audit — records revocation in device_approval_events and returns the revoked state', async () => {
    const device = await enrollDevice();
    const approved = await adminAction(device.deviceId, 'approve');
    expect(approved.status).toBe(201);

    const revoked = await adminAction(device.deviceId, 'revoke', 'Révocation E2E contrôlée');
    expect(revoked.status).toBe(201);
    expect(revoked.body.approvalStatus).toBe('revoked');

    const status = await readServerStatus(device);
    expect(status).toMatchObject({ success: true, tenantId, approvalStatus: 'revoked' });

    const audit = await pg.pool.query(
      `SELECT event_type, from_status, to_status, device_id, tenant_id
         FROM public.device_approval_events
        WHERE tenant_id = $1 AND device_id = $2 AND event_type = 'revoked'`,
      [tenantId, device.deviceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      event_type: 'revoked',
      from_status: 'approved',
      to_status: 'revoked',
      device_id: device.deviceId,
      tenant_id: tenantId,
    });
  }, 120_000);

  it('E2E-03 server boundary — records rejection and reports the rejected state', async () => {
    const device = await enrollDevice();
    const rejected = await adminAction(device.deviceId, 'reject', 'Rejet E2E contrôlé');
    expect(rejected.status).toBe(201);
    expect(rejected.body.approvalStatus).toBe('rejected');

    const status = await readServerStatus(device);
    expect(status).toMatchObject({ success: true, tenantId, approvalStatus: 'rejected' });
  }, 120_000);
});
