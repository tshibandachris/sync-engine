import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  stop: () => Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const pool = new Pool({
    connectionString: container.getConnectionUri(),
  });

  /*
   * Tables minimales avant application de la migration.
   *
   * IMPORTANT :
   * Le schéma Drizzle doit correspondre exactement aux colonnes
   * réellement présentes dans PostgreSQL.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
      longitude DOUBLE PRECISION NOT NULL DEFAULT 0,
      deleted_at BIGINT,
      sync_seq BIGINT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS missions (
      id UUID PRIMARY KEY,
      agent_id UUID NOT NULL,
      site_id UUID,
      title TEXT NOT NULL,
      deleted_at BIGINT,
      sync_seq BIGINT NOT NULL DEFAULT 0
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
   * Compatibilité avec une base initiale éventuellement créée
   * avec l'ancien schéma minimal.
   */
  await pool.query(`
    ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS deleted_at BIGINT,
      ADD COLUMN IF NOT EXISTS sync_seq BIGINT NOT NULL DEFAULT 0;

    ALTER TABLE missions
      ADD COLUMN IF NOT EXISTS site_id UUID,
      ADD COLUMN IF NOT EXISTS deleted_at BIGINT,
      ADD COLUMN IF NOT EXISTS sync_seq BIGINT NOT NULL DEFAULT 0;

    ALTER TABLE check_ins
      ADD COLUMN IF NOT EXISTS sync_seq BIGINT NOT NULL DEFAULT 0;
  `);

  /*
   * Application de la migration sync_seq.
   */
  const migration = await readFile(
    new URL('../../migrations/001_sync_infra.sql', import.meta.url),
    'utf8',
  );

  await pool.query(migration);

  return {
    container,
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}