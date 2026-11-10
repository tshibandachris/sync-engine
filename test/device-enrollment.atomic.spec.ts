import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { DeviceEnrollmentService } from '../src/device-enrollment.service.js';
import { assertEnrollmentDatabaseIdentity } from '../src/device-enrollment-db-guard.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Device enrollment atomic pairing-code redemption', () => {
  let pg: TestPostgres;
  let service: DeviceEnrollmentService;
  const tenantId = randomUUID();
  const storeId = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    service = new DeviceEnrollmentService(pg.enrollmentDb as any);
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
  }, 120_000);

  afterAll(async () => { await pg?.stop(); });

  async function createCode(code: string) {
    const codeHash = createHash('sha256').update(code).digest('hex');
    await pg.pool.query(
      `INSERT INTO device_pairing_codes
       (tenant_id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [tenantId, storeId, codeHash, randomUUID()],
    );
  }

  function dto(activationCode: string, fingerprint: string, deviceName = 'Caisse test') {
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      jti: randomUUID(),
      htm: 'POST',
      htu: '/api/v1/devices/enroll',
      iat: Math.floor(Date.now() / 1000),
      code_hash: createHash('sha256').update(activationCode).digest('base64url'),
      fingerprint,
    })).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: privateKeyPem,
      dsaEncoding: 'ieee-p1363',
    });
    return {
      activationCode,
      deviceName,
      hardwareInfo: { hostname: 'pos-01', platform: 'win32', arch: 'x64', osRelease: '10.0' },
      publicKeyPem,
      initialProof: `${signingInput}.${signature.toString('base64url')}`,
    };
  }

  it('allows exactly one of two concurrent enrollments to consume a code', async () => {
    const code = 'ED26-89AB';
    await createCode(code);

    const results = await Promise.allSettled([
      service.enrollDevice(dto(code, 'hardware-a'), 'hardware-a'),
      service.enrollDevice(dto(code, 'hardware-b'), 'hardware-b'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);

    const codes = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(code).digest('hex')],
    );
    const devices = await pg.pool.query(
      'SELECT count(*)::int AS count FROM devices WHERE tenant_id = $1',
      [tenantId],
    );
    expect(codes.rows[0].used_at).not.toBeNull();
    expect(devices.rows[0].count).toBe(1);
    const audit = await pg.pool.query(
      `SELECT count(*)::int AS count
       FROM device_approval_events
       WHERE tenant_id = $1 AND event_type = 'requested'
         AND to_status = 'pending_approval' AND from_status IS NULL`,
      [tenantId],
    );
    expect(audit.rows[0].count).toBe(1);
  }, 120_000);

  it('rolls back code consumption when device insertion fails', async () => {
    const code = 'ED26-89AC';
    await createCode(code);
    await service.enrollDevice(dto(code, 'same-hardware'), 'same-hardware');

    // A second, valid code cannot create a duplicate device fingerprint.
    const secondCode = 'ED26-89AD';
    await createCode(secondCode);
    await expect(service.enrollDevice(dto(secondCode, 'same-hardware'), 'same-hardware'))
      .rejects.toBeInstanceOf(ConflictException);

    const state = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(secondCode).digest('hex')],
    );
    expect(state.rows[0].used_at).toBeNull();
  }, 120_000);

  it('rejects the general sync_app connection as an enrollment executor at bootstrap', async () => {
    await expect(assertEnrollmentDatabaseIdentity(pg.appPool)).rejects.toThrow(
      /BOOTSTRAP_SECURITY_ERROR: DEVICE_ENROLLMENT_DATABASE_URL/i,
    );
  });

  it('accepts only the dedicated non-superuser executor login at bootstrap', async () => {
    await expect(assertEnrollmentDatabaseIdentity(pg.enrollmentPool)).resolves.toBeUndefined();
  });


  it('rejects an enrollment login that has BYPASSRLS even when it inherits the executor role', async () => {
    await pg.pool.query(
      "CREATE ROLE device_enrollment_unsafe LOGIN INHERIT BYPASSRLS PASSWORD 'unsafe_test_pw'",
    );
    await pg.pool.query('GRANT device_enrollment_executor TO device_enrollment_unsafe');
    const { Pool } = await import('pg');
    const unsafePool = new Pool({
      ...pg.connectionOptions,
      user: 'device_enrollment_unsafe',
      password: 'unsafe_test_pw',
    });
    try {
      await expect(assertEnrollmentDatabaseIdentity(unsafePool)).rejects.toThrow(
        /BOOTSTRAP_SECURITY_ERROR: DEVICE_ENROLLMENT_DATABASE_URL/i,
      );
    } finally {
      await unsafePool.end();
      await pg.pool.query('DROP ROLE device_enrollment_unsafe');
    }
  });

  it('denies sync_app EXECUTE while granting the dedicated executor the exact function capability', async () => {
    const signature = 'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)';
    const privileges = await pg.pool.query(
      `SELECT
        has_function_privilege('sync_app', $1, 'EXECUTE') AS sync_allowed,
        has_function_privilege('device_enrollment_test', $1, 'EXECUTE') AS executor_allowed,
        pg_has_role('device_enrollment_test', 'sync_app', 'MEMBER') AS executor_is_sync_member,
        pg_has_role('device_enrollment_test', 'device_enrollment_executor', 'SET') AS can_set_executor_role`,
      [signature],
    );
    expect(privileges.rows[0]).toEqual({
      sync_allowed: false,
      executor_allowed: true,
      executor_is_sync_member: false,
      can_set_executor_role: false,
    });
  });

  it('rejects direct invocation of the privileged enrollment function by sync_app', async () => {
    await expect(pg.appPool.query(
      `SELECT * FROM public.register_device_enrollment_with_credential(
        $1::text, $2::uuid, $3::varchar, $4::varchar, $5::jsonb, $6::text, $7::varchar, $8::uuid
      )`,
      ['a'.repeat(64), randomUUID(), 'Forged POS', 'forged-fingerprint', JSON.stringify({}), 'forged-key', 'b'.repeat(43), randomUUID()],
    )).rejects.toMatchObject({ code: '42501' });
  });


  it('gives the enrollment login no direct table or helper-function access', async () => {
    const privileges = await pg.pool.query(`
      SELECT
        has_table_privilege('device_enrollment_test', 'public.devices', 'SELECT') AS can_read_devices,
        has_table_privilege('device_enrollment_test', 'public.devices', 'INSERT') AS can_insert_devices,
        has_table_privilege('device_enrollment_test', 'public.device_credentials', 'SELECT') AS can_read_credentials,
        has_table_privilege('device_enrollment_test', 'public.device_credentials', 'INSERT') AS can_insert_credentials,
        has_table_privilege('device_enrollment_test', 'public.device_approval_events', 'INSERT') AS can_insert_events,
        has_function_privilege('device_enrollment_test', 'public.redeem_device_pairing_code(text)', 'EXECUTE') AS can_redeem_pairing_directly,
        has_function_privilege('device_enrollment_test', 'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)', 'EXECUTE') AS can_create_device_directly
    `);
    expect(privileges.rows[0]).toEqual({
      can_read_devices: false,
      can_insert_devices: false,
      can_read_credentials: false,
      can_insert_credentials: false,
      can_insert_events: false,
      can_redeem_pairing_directly: false,
      can_create_device_directly: false,
    });
  });

  it('keeps sync_app unable to write credentials/events or set an approval decision directly', async () => {
    const privileges = await pg.pool.query(`
      SELECT
        has_table_privilege('sync_app', 'public.device_credentials', 'INSERT') AS credential_insert,
        has_table_privilege('sync_app', 'public.device_approval_events', 'INSERT') AS event_insert,
        has_table_privilege('sync_app', 'public.devices', 'INSERT') AS device_insert
    `);
    expect(privileges.rows[0]).toEqual({
      credential_insert: false,
      event_insert: false,
      device_insert: true,
    });
  });



  it('allows sync_app to create only a pending device, never an approved device', async () => {
    const approvedAttempt = await pg.appPool.query(
      `INSERT INTO public.devices (
        id, tenant_id, store_id, name, fingerprint, hardware_info,
        approval_status, approved_at, approved_by
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'approved', now(), $7)`,
      [randomUUID(), tenantId, storeId, 'Forged approval', 'forged-approved-fingerprint', JSON.stringify({}), randomUUID()],
    ).catch((error: { code?: string }) => error);
    expect(approvedAttempt).toMatchObject({ code: '42501' });
  });

  it('applies migration 036 with a pre-provisioned executor and a migration role without CREATEROLE', async () => {
    const client = await pg.pool.connect();
    try {
      await client.query(`
        CREATE ROLE device_enrollment_migration_test
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS
      `);
      await client.query('ALTER SCHEMA public OWNER TO device_enrollment_migration_test');
      await client.query(`
        ALTER FUNCTION public.register_device_enrollment_with_credential(
          text, uuid, varchar, varchar, jsonb, text, varchar, uuid
        ) OWNER TO device_enrollment_migration_test
      `);
      await client.query('ALTER FUNCTION public.redeem_device_pairing_code(text) OWNER TO device_enrollment_migration_test');
      await client.query(
        'ALTER FUNCTION public.register_device_enrollment(uuid, uuid, uuid, uuid, varchar, varchar, jsonb) OWNER TO device_enrollment_migration_test',
      );
      await client.query('SET ROLE device_enrollment_migration_test');
      const migration = readFileSync(
        path.resolve('migrations/036_device_enrollment_executor_role.sql'),
        'utf8',
      );
      await client.query(migration);

      const roleState = await client.query(`
        SELECT rolcreaterole, rolcanlogin, rolsuper, rolbypassrls
        FROM pg_catalog.pg_roles
        WHERE rolname = 'device_enrollment_migration_test'
      `);
      expect(roleState.rows[0]).toEqual({
        rolcreaterole: false,
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
      });
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });

});
