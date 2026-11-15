import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

    const connectionOptions = {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
    };
    const pool = new Pool({
      ...connectionOptions,
      user: container.getUsername(),
      password: container.getPassword(),
    });

    try {
      // Use the exact production migration runner rather than a hand-maintained
      // test-only list. This keeps migration order, ledger behavior, recovery,
      // and role provisioning aligned with deployment.
      const repositoryRoot = process.cwd();
      const migrationScript = path.resolve(repositoryRoot, 'scripts/migrate.sh');
      const migrationEnv = {
        ...process.env,
        DB_HOST: container.getHost(),
        DB_NAME: container.getDatabase(),
        DB_USER: container.getUsername(),
        MIGRATIONS_DIR: path.resolve(repositoryRoot, 'migrations'),
        PGPASSWORD: container.getPassword(),
        PGHOST: container.getHost(),
        PGPORT: String(container.getPort()),
        PGUSER: container.getUsername(),
        PGDATABASE: container.getDatabase(),
        SYNC_APP_PASSWORD: 'sync_app_pw_test',
        DEVICE_ENROLLMENT_PASSWORD: 'device_enrollment_login_pw_test',
        DEVICE_ADMIN_PASSWORD: 'device_admin_login_pw_test',
        MAINTENANCE_PASSWORD: 'maintenance_login_pw_test',
      };
      execFileSync('sh', [migrationScript], {
        cwd: repositoryRoot,
        env: migrationEnv,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const db = drizzle(pool, { schema });

      // Match the actual deployment login names and role memberships.
      const appPool = new Pool({
        ...connectionOptions,
        user: 'sync_app',
        password: migrationEnv.SYNC_APP_PASSWORD,
      });
      const appDb = drizzle(appPool, { schema });

      const enrollmentPool = new Pool({
        ...connectionOptions,
        user: 'device_enrollment_login',
        password: migrationEnv.DEVICE_ENROLLMENT_PASSWORD,
      });
      const enrollmentDb = drizzle(enrollmentPool, { schema });

      const adminPool = new Pool({
        ...connectionOptions,
        user: 'device_admin_login',
        password: migrationEnv.DEVICE_ADMIN_PASSWORD,
      });
      const adminDb = drizzle(adminPool, { schema });

      const maintenancePool = new Pool({
        ...connectionOptions,
        user: 'maintenance_login',
        password: migrationEnv.MAINTENANCE_PASSWORD,
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
        connectionOptions,
      );
    } catch (error) {
      await pool.end().catch(() => undefined);
      await container.stop().catch(() => undefined);
      throw new Error(
        'Test PostgreSQL setup failed while running scripts/migrate.sh. Ensure psql is installed and the production migration runner can reach the Testcontainers database.',
        { cause: error },
      );
    }
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