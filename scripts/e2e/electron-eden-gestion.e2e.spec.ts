import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../../src/main.js';
import type { AttachmentStorage } from '../../src/attachment-storage.js';
import { assertEnrollmentDatabaseIdentity } from '../../src/device-enrollment-db-guard.js';
import { assertDeviceAdminDatabaseIdentity } from '../../src/device-admin-db-guard.js';
import { startTestPostgres, type TestPostgres } from '../../test/helpers/testcontainers-pg.js';

const requireElectron = createRequire(path.resolve(process.cwd(), 'electron-app/package.json'));
const electronBinary = requireElectron('electron') as string;
const ISSUER = 'https://idp.eden-e2e.test';
const AUDIENCE = 'eden-sync';
const KEY_ID = 'eden-e2e-es256';
const TEST_JWT_SECRET = 'test-only-jwt-module-secret-not-used-for-idp-verification';
const storage: AttachmentStorage = {
  async delete() {},
  async listByPrefix() { return []; },
  async presignPut() { return { url: 'https://storage.test/unused-put', expiresIn: 60 }; },
  async presignGet() { return { url: 'https://storage.test/unused-get', expiresIn: 60 }; },
  async head() { return { exists: false }; },
};

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a loopback port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForRenderer(port: number, child: ChildProcess, readLogs: () => string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Electron exited before renderer startup: ' + readLogs().slice(-6000));
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      if (response.ok) {
        const targets = await response.json() as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((target) =>
          target.type === 'page' && target.url.endsWith('/renderer/index.html') &&
          typeof target.webSocketDebuggerUrl === 'string');
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Electron renderer did not start within 60 seconds: ' + readLogs().slice(-6000));
}

let devtoolsCommandId = 0;
async function evaluate<T>(socket: WebSocket, expression: string): Promise<T> {
  const id = ++devtoolsCommandId;
  const response = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for Electron DevTools evaluation.'));
    }, 20_000);
    const onMessage = (event: MessageEvent) => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  if (response.error) throw new Error(response.error.message || 'Electron DevTools command failed.');
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text || 'Renderer evaluation failed.');
  }
  return response.result?.result?.value as T;
}

async function checkStatusUntilReady(socket: WebSocket, expected: 'pending_approval' | 'approved'): Promise<any> {
  const deadline = Date.now() + 20_000;
  let result: any;
  while (Date.now() < deadline) {
    result = await evaluate<any>(socket, 'window.eden.checkDeviceStatus()');
    if (result?.success && result.approvalStatus === expected) return result;
    if (result?.reason !== 'CHECK_ALREADY_RUNNING') {
      throw new Error('Electron device-status verification failed: ' + JSON.stringify(result));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for Electron device-status verification: ' + JSON.stringify(result));
}

describe('E2E-01 — activation nominale via le véritable client Electron', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let idpServer: Server | undefined;
  let apiBaseUrl = '';
  let tenantId = '';
  let agentId = '';
  let agentToken = '';
  let activationCode = '';
  let tempRoot = '';
  let electron: ChildProcess | undefined;
  let electronLogs = '';
  let socket: WebSocket | undefined;
  let idpPrivateKey: CryptoKey;
  const originalEnv: Record<string, string | undefined> = {};

  async function signAgentToken(permissions: string[] = []) {
    return new SignJWT({ agent_id: agentId, tenantId, permissions })
      .setProtectedHeader({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(agentId)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(idpPrivateKey);
  }

  beforeAll(async () => {
    for (const key of ['NODE_ENV', 'JWT_SECRET', 'JWKS_URL', 'JWT_ISSUER', 'JWT_AUDIENCE', 'REDIS_URL']) {
      originalEnv[key] = process.env[key];
    }
    pg = await startTestPostgres();
    await assertEnrollmentDatabaseIdentity(pg.enrollmentPool);
    await assertDeviceAdminDatabaseIdentity(pg.adminPool);

    tenantId = randomUUID();
    agentId = randomUUID();
    const storeId = randomUUID();
    await pg.pool.query('INSERT INTO public.tenants (id, first_seen_at) VALUES ($1, $2)', [tenantId, Date.now()]);

    const pair = await generateKeyPair('ES256', { extractable: true });
    idpPrivateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    const jwks = { keys: [{ ...publicJwk, kid: KEY_ID, alg: 'ES256', use: 'sig' }] };
    let idpBaseUrl = '';
    idpServer = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200);
        res.end(JSON.stringify({
          issuer: ISSUER,
          jwks_uri: idpBaseUrl + '/jwks.json',
          id_token_signing_alg_values_supported: ['ES256'],
        }));
      } else if (req.url === '/jwks.json') {
        res.writeHead(200);
        res.end(JSON.stringify(jwks));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    });
    idpServer.listen(0, '127.0.0.1');
    await once(idpServer, 'listening');
    const idpAddress = idpServer.address();
    if (!idpAddress || typeof idpAddress === 'string') throw new Error('OIDC test provider did not bind.');
    idpBaseUrl = 'http://127.0.0.1:' + idpAddress.port;

    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.JWKS_URL = idpBaseUrl + '/jwks.json';
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

    const suffix = randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase();
    activationCode = 'E2E1-' + suffix;
    const codeHash = createHash('sha256').update(activationCode, 'utf8').digest('hex');
    await pg.pool.query(
      'INSERT INTO public.device_pairing_codes (tenant_id, store_id, code_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval \'10 minutes\')',
      [tenantId, storeId, codeHash, agentId],
    );
    agentToken = await signAgentToken();

    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'eden-e2e-01-'));
    const configRoot = path.join(tempRoot, 'config');
    const profileRoot = path.join(tempRoot, 'profile');
    const debugPort = await freePort();
    const child = spawn(electronBinary, [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--password-store=gnome-libsecret',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + debugPort,
      '--user-data-dir=' + profileRoot,
    ], {
      cwd: path.resolve(process.cwd(), 'electron-app'),
      env: {
        ...process.env,
        EDEN_SYNC_URL: apiBaseUrl,
        EDEN_SYNC_TOKEN: agentToken,
        XDG_CONFIG_HOME: configRoot,
        XDG_CACHE_HOME: path.join(tempRoot, 'cache'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    electron = child;
    child.stdout?.on('data', (chunk) => { electronLogs += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { electronLogs += chunk.toString(); });

    const debuggerUrl = await waitForRenderer(debugPort, child, () => electronLogs);
    socket = new WebSocket(debuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener('error', () => reject(new Error('Could not connect to Electron DevTools.')), { once: true });
    });
    const preloadDeadline = Date.now() + 30_000;
    while (Date.now() < preloadDeadline) {
      try {
        if (await evaluate<boolean>(socket, "typeof window.eden === 'object'")) break;
      } catch {
        // The renderer may still be evaluating its preload and first script.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!await evaluate<boolean>(socket, "typeof window.eden === 'object'")) {
      throw new Error('Electron preload API window.eden was not exposed.');
    }
  }, 180_000);

  afterAll(async () => {
    try {
      socket?.close();
      if (electron && electron.exitCode === null && electron.signalCode === null) {
        electron.kill('SIGTERM');
        await Promise.race([
          once(electron, 'close').then(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 8_000)),
        ]);
        if (electron.exitCode === null && electron.signalCode === null) electron.kill('SIGKILL');
      }
      if (app) await app.close();
      if (idpServer?.listening) {
        await new Promise<void>((resolve, reject) =>
          idpServer!.close((error) => error ? reject(error) : resolve()));
      }
      if (pg) await pg.stop();
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('enrôle, lie le tenant, chiffre les credentials puis confirme l’approbation serveur', async () => {
    expect(socket).toBeDefined();

    const initialStatus = await evaluate<any>(socket!, 'window.eden.getStatus()');
    expect(initialStatus.authState, JSON.stringify(initialStatus)).toBe('ready');
    expect(initialStatus.agentAuthState).toBe('authenticated');
    expect(initialStatus.deviceTrustState).toBe('unregistered');

    const registration = await evaluate<any>(
      socket!,
      'window.eden.registerDevice(' + JSON.stringify({
        activationCode,
        deviceName: 'E2E-01-ELECTRON',
      }) + ')',
    );
    expect(registration).toMatchObject({ success: true, approvalStatus: 'pending_approval' });
    expect(registration.deviceId).toMatch(/^[0-9a-f-]{36}$/i);

    const appDataDir = path.join(tempRoot, 'config', 'EdenGestion');
    const tokenCiphertext = await readFile(path.join(appDataDir, 'device-token.enc'));
    const credentialCiphertext = await readFile(path.join(appDataDir, 'device-credential.enc'));
    expect(tokenCiphertext.length).toBeGreaterThan(0);
    expect(credentialCiphertext.length).toBeGreaterThan(0);
    expect(tokenCiphertext.includes(Buffer.from(agentToken))).toBe(false);
    expect(credentialCiphertext.toString('utf8')).not.toContain('BEGIN PRIVATE KEY');
    expect(credentialCiphertext.toString('utf8')).not.toContain(agentToken);

    const tenantBinding = execFileSync('sqlite3', [
      path.join(appDataDir, 'data.db'),
      'SELECT tenant_id FROM device_binding WHERE singleton = 1;',
    ], { encoding: 'utf8' }).trim();
    expect(tenantBinding).toBe(tenantId);

    const enrolledRows = await pg.pool.query(
      'SELECT d.id, d.tenant_id, d.approval_status, c.algorithm, c.key_thumbprint, c.status FROM public.devices d JOIN public.device_credentials c ON c.tenant_id = d.tenant_id AND c.device_id = d.id WHERE d.id = $1 AND d.tenant_id = $2',
      [registration.deviceId, tenantId],
    );
    expect(enrolledRows.rows).toHaveLength(1);
    expect(enrolledRows.rows[0]).toMatchObject({
      id: registration.deviceId,
      tenant_id: tenantId,
      approval_status: 'pending_approval',
      algorithm: 'ES256',
      status: 'active',
    });

    const pendingStatus = await checkStatusUntilReady(socket!, 'pending_approval');
    expect(pendingStatus).toMatchObject({
      success: true,
      deviceId: registration.deviceId,
      tenantId,
      approvalStatus: 'pending_approval',
      hasActiveCredential: true,
    });

    const approveToken = await signAgentToken(['devices:approve']);
    const approval = await request(app.getHttpServer())
      .post('/api/v1/admin/devices/' + registration.deviceId + '/approve')
      .set('Authorization', 'Bearer ' + approveToken);
    expect(approval.status).toBe(201);
    expect(approval.body.approvalStatus).toBe('approved');

    const confirmedStatus = await checkStatusUntilReady(socket!, 'approved');
    expect(confirmedStatus).toMatchObject({
      success: true,
      deviceId: registration.deviceId,
      tenantId,
      approvalStatus: 'approved',
      hasActiveCredential: true,
    });

    const localStatus = await evaluate<any>(socket!, 'window.eden.getDeviceStatus()');
    expect(enrolledRows.rows[0].key_thumbprint).toBe(localStatus.thumbprint);
    expect(localStatus).toMatchObject({
      isEnrolled: true,
      deviceId: registration.deviceId,
      trustState: 'approved',
      deviceProofReady: true,
      serverHasActiveCredential: true,
    });

    const audit = await pg.pool.query(
      'SELECT event_type, from_status, to_status, actor_id FROM public.device_approval_events WHERE tenant_id = $1 AND device_id = $2 ORDER BY created_at ASC, id ASC',
      [tenantId, registration.deviceId],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(['requested', 'approved']);
    expect(audit.rows[1]).toMatchObject({
      from_status: 'pending_approval',
      to_status: 'approved',
      actor_id: agentId,
    });

    const pairing = await pg.pool.query(
      'SELECT used_at FROM public.device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(activationCode, 'utf8').digest('hex')],
    );
    expect(pairing.rows[0]?.used_at).not.toBeNull();

    const evidenceDirectory = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), 'artifacts');
    await mkdir(evidenceDirectory, { recursive: true });
    const evidence = {
      scenario: 'E2E-01',
      result: 'PASS',
      commit: process.env.GITHUB_SHA || null,
      executedAt: new Date().toISOString(),
      environment: {
        electron: 'real Electron main process and renderer',
        api: 'ephemeral NestJS API',
        identityProvider: 'ephemeral local ES256 OIDC/JWKS',
        database: 'ephemeral PostgreSQL Testcontainers',
      },
      device: {
        deviceId: registration.deviceId,
        tenantId,
        keyThumbprint: localStatus.thumbprint,
        approvalStatus: 'approved',
      },
      checks: {
        agentTokenEncrypted: true,
        deviceCredentialEncrypted: true,
        tenantBindingPersistedInSqlite: true,
        serverCredentialActive: true,
        deviceProofPendingVerifiedByElectron: true,
        deviceProofApprovalVerifiedByElectron: true,
        activationCodeConsumed: true,
        approvalAudit: audit.rows.map((row) => ({
          eventType: row.event_type,
          fromStatus: row.from_status,
          toStatus: row.to_status,
          actorId: row.actor_id,
        })),
      },
    };
    await writeFile(
      path.join(evidenceDirectory, 'e2e-01-evidence.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log('E2E_01_INTEGRATED_PASS');
    console.log('E2E_01_EVIDENCE tenant_binding=verified credential_encryption=verified es256=verified api=verified postgres=verified audit=verified');
  }, 120_000);
});
