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

  private constructor(
    container: Awaited<
      ReturnType<PostgreSqlContainer['start']>
    >,
    pool: Pool,
    db: ReturnType<typeof drizzle<typeof schema>>,
    appPool: Pool,
    appDb: ReturnType<typeof drizzle<typeof schema>>,
  ) {
    this.container = container;
    this.pool = pool;
    this.db = db;
    this.appPool = appPool;
    this.appDb = appDb;
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

    return new TestPostgres(
      container,
      pool,
      db,
      appPool,
      appDb,
    );
  }

  async stop(): Promise<void> {
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