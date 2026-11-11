import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../src/schema.js';

export class TestPostgres {
  private readonly container: Awaited<
    ReturnType<PostgreSqlContainer['start']>
  >;

  readonly pool: Pool;

  readonly db: ReturnType<typeof drizzle<typeof schema>>;

  readonly appPool: Pool;

  readonly appDb: ReturnType<typeof drizzle<typeof schema>>;

  readonly enrollmentPool: Pool;

  readonly enrollmentDb: ReturnType<typeof drizzle<typeof schema>>;

  readonly adminPool: Pool;

  readonly adminDb: ReturnType<typeof drizzle<typeof schema>>;

  readonly maintenancePool: Pool;

  readonly maintenanceDb: ReturnType<typeof drizzle<typeof schema>>;

  readonly connectionOptions: { host: string; port: number; database: string };

  private constructor(
    container: Awaited<
      ReturnType<PostgreSqlContainer['start']>
    >,
    pool: Pool,
    db: ReturnType<typeof drizzle<typeof schema>>,
    appPool: Pool,
    appDb: ReturnType<typeof drizzle<typeof schema>>,
    enrollmentPool: Pool,
    enrollmentDb: ReturnType<typeof drizzle<typeof schema>>,
    adminPool: Pool,
    adminDb: ReturnType<typeof drizzle<typeof schema>>,
    maintenancePool: Pool,
    maintenanceDb: ReturnType<typeof drizzle<typeof schema>>,
    connectionOptions: { host: string; port: number; database: string },
  ) {
    this.container = container;
    this.pool = pool;
    this.db = db;
    this.appPool = appPool;
    this.appDb = appDb;
    this.enrollmentPool = enrollmentPool;
    this.enrollmentDb = enrollmentDb;
    this.adminPool = adminPool;
    this.adminDb = adminDb;
    this.maintenancePool = maintenancePool;
    this.maintenanceDb = maintenanceDb;
    this.connectionOptions = connectionOptions;
  }

  static async start(): Promise<TestPostgres> {
    const container = await new PostgreSqlContainer(
      'postgres:16-alpine',
    )
      .withDatabase('sync_engine_test')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    const pool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    });

    /*
     * ========================================================
     * TABLES DE BASE
     * ========================================================
     *
     * IMPORTANT :
     * check_ins possède sync_seq.
     *
     * missions/sites recevront leurs colonnes incrémentales
     * via migration 002.
     */

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        longitude DOUBLE PRECISION NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS missions (
        id UUID PRIMARY KEY,
        agent_id UUID NOT NULL,
        site_id UUID,
        title TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS check_ins (
        id UUID PRIMARY KEY,
        mission_id UUID NOT NULL,
        agent_id UUID NOT NULL,
        check_in_time BIGINT NOT NULL,
        check_out_time BIGINT,
        check_in_lat DOUBLE PRECISION NOT NULL,
        check_in_lng DOUBLE PRECISION NOT NULL,
        check_in_method TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        deleted_at BIGINT,
        sync_seq BIGINT NOT NULL DEFAULT 0
      );
    `);

    /*
     * ========================================================
     * MIGRATIONS
     * ========================================================
     */

    const migrationsDir = path.resolve('migrations');

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const migration1File = migrationFiles.find((file) => {
      if (file === '002_incremental_missions_sites.sql') {
        return false;
      }

      const content = fs.readFileSync(
        path.join(migrationsDir, file),
        'utf8',
      );

      return content.includes('global_sync_seq');
    });

    if (!migration1File) {
      throw new Error(
        'Migration sync infrastructure introuvable dans migrations/.',
      );
    }

    const migration2Path = path.join(
      migrationsDir,
      '002_incremental_missions_sites.sql',
    );

    if (!fs.existsSync(migration2Path)) {
      throw new Error(
        'Migration 002_incremental_missions_sites.sql introuvable.',
      );
    }

    const migration1 = fs.readFileSync(
      path.join(migrationsDir, migration1File),
      'utf8',
    );

    const migration2 = fs.readFileSync(
      migration2Path,
      'utf8',
    );

  const migration3 = fs.readFileSync(
    path.join(migrationsDir, '003_sync_conflicts.sql'),
    'utf8',
  );

  const migration4 = fs.readFileSync(
    path.join(migrationsDir, '004_conflict_resolution.sql'),
    'utf8',
  );

  const migration5 = fs.readFileSync(
    path.join(migrationsDir, '005_purge_function.sql'),
    'utf8',
  );

  const migration6 = fs.readFileSync(
    path.join(migrationsDir, '006_multi_tenancy.sql'),
    'utf8',
  );

  const migration7 = fs.readFileSync(
    path.join(migrationsDir, '007_attachments.sql'),
    'utf8',
  );

  const migration8 = fs.readFileSync(
    path.join(migrationsDir, '008_sync_purge_state.sql'),
    'utf8',
  );

  const migration9 = fs.readFileSync(
    path.join(migrationsDir, '009_purge_tombstones.sql'),
    'utf8',
  );

  const migration10 = fs.readFileSync(
    path.join(migrationsDir, '010_rls.sql'),
    'utf8',
  );

  const migration11 = fs.readFileSync(
    path.join(migrationsDir, '011_sync_app_role.sql'),
    'utf8',
  );

  const migration12 = fs.readFileSync(
    path.join(migrationsDir, '012_sync_app_nologin.sql'),
    'utf8',
  );

  const migration13 = fs.readFileSync(
    path.join(migrationsDir, '013_check_ins_site_id.sql'),
    'utf8',
  );

  const migration14 = fs.readFileSync(
    path.join(migrationsDir, '014_sync_logs.sql'),
    'utf8',
  );

  const migration17 = fs.readFileSync(
    path.join(migrationsDir, '017_purge_tombstones_returns_orphans.sql'),
    'utf8',
  );

  const migration15 = fs.readFileSync(
    path.join(migrationsDir, '015_purge_sync_logs.sql'),
    'utf8',
  );

  const migration16 = fs.readFileSync(
    path.join(migrationsDir, '016_tenants_registry.sql'),
    'utf8',
  );

  // Apply POS migrations in production order before POS integration tests.
  const posMigrations = [
    '018_products.sql',
    '019_staff.sql',
    '020_cash_sessions.sql',
    '021_sales.sql',
    '022_sale_lines.sql',
    '023_stock_movements.sql',
    '024_inventory_counts.sql',
    '025_pos_reconciliation.sql',
    '026_courriers.sql',
    '027_courrier_attachments.sql',
    '028_courrier_workflow_and_audit.sql',
    '029_create_device_pairing_codes.sql',
    '030_create_enrolled_devices.sql',
    '031_device_approval_and_credentials.sql',
    '032_device_security_hardening.sql',
    '033_atomic_device_enrollment.sql',
    '034_device_proof_replay_protection.sql',
    '035_device_enrollment_with_credential.sql',
    '036_device_enrollment_executor_role.sql',
    '037_device_admin_approval_capability.sql',
    '038_device_enrollment_owner_schema_hardening.sql',
    '039_purge_expired_device_proof_nonces.sql',
    '040_maintenance_purge_executor.sql',
    '041_maintenance_purge_batch_limits.sql',
  ].map((file) => fs.readFileSync(path.join(migrationsDir, file), 'utf8'));

    console.log(
      `[TestPostgres] Migration 001: ${migration1File}`,
    );

    console.log(
      '[TestPostgres] Migration 002: 002_incremental_missions_sites.sql',
    );

    await pool.query(migration1);

    await pool.query(migration2);
  await pool.query(migration3);
  await pool.query(migration4);
  await pool.query(migration5);
  await pool.query(migration6);
  await pool.query(migration7);
  await pool.query(migration8);
  await pool.query(migration9);
  await pool.query(migration10);
  await pool.query(migration11);

  await pool.query(migration12);

  await pool.query(migration13);

  await pool.query(migration14);

  await pool.query(migration15);

  await pool.query(migration17);

  await pool.query(migration16);
  for (const migration of posMigrations) await pool.query(migration);

    /*
     * ========================================================
     * DRIZZLE
     * ========================================================
     */

    const db = drizzle(pool, {
      schema,
    });

    // Migration 012 sets sync_app to NOLOGIN so no password ships in
    // the repo. The test container is ephemeral and isolated, so we
    // re-enable LOGIN with a throwaway password here, purely for the
    // duration of this test process.
    await pool.query("ALTER ROLE sync_app LOGIN PASSWORD 'sync_app_pw_test'");

    // Second pool connected as the non-superuser application role.
    // RLS applies fully: no bypass, no ownership exception.
    const appPool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'sync_app',
      password: 'sync_app_pw_test',
    });

    const appDb = drizzle(appPool, {
      schema,
    });

    // Dedicated LOGIN used only by the enrollment capability pool.
    await pool.query("CREATE ROLE device_enrollment_test LOGIN INHERIT PASSWORD 'device_enrollment_test_pw'");
    await pool.query('GRANT device_enrollment_executor TO device_enrollment_test WITH INHERIT TRUE, SET FALSE');
    const enrollmentPool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'device_enrollment_test',
      password: 'device_enrollment_test_pw',
    });
    const enrollmentDb = drizzle(enrollmentPool, { schema });

    // Dedicated LOGIN used only by the isolated device administration capability.
    await pool.query("CREATE ROLE device_admin_test LOGIN INHERIT PASSWORD 'device_admin_test_pw'");
    await pool.query('GRANT device_admin_executor TO device_admin_test WITH INHERIT TRUE, SET FALSE');
    const adminPool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'device_admin_test',
      password: 'device_admin_test_pw',
    });
    const adminDb = drizzle(adminPool, { schema });

    // Dedicated LOGIN with only the maintenance purge capability.
    await pool.query("CREATE ROLE maintenance_test LOGIN INHERIT PASSWORD 'maintenance_test_pw'");
    await pool.query('GRANT maintenance_purge_executor TO maintenance_test WITH INHERIT TRUE, SET FALSE');
    const maintenancePool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'maintenance_test',
      password: 'maintenance_test_pw',
    });
    const maintenanceDb = drizzle(maintenancePool, { schema });

    return new TestPostgres(
      container,
      pool,
      db,
      appPool,
      appDb,
      enrollmentPool,
      enrollmentDb,
      adminPool,
      adminDb,
      maintenancePool,
      maintenanceDb,
      { host: container.getHost(), port: container.getPort(), database: container.getDatabase() },
    );
  }

  async stop(): Promise<void> {
    await this.maintenancePool.end();
    await this.adminPool.end();
    await this.enrollmentPool.end();
    await this.appPool.end();
    await this.pool.end();
    await this.container.stop();
  }
}

/*
 * Compatibilité avec le test existant.
 */
export async function startTestPostgres(): Promise<TestPostgres> {
  return TestPostgres.start();
}