import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: Pool;
let root: string;
let counter = 0;
const script = path.resolve('scripts/migrate.sh');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('postgres').withUsername('postgres').withPassword('postgres').start();
  admin = new Pool({
    host: container.getHost(), port: container.getPort(), database: 'postgres',
    user: 'postgres', password: 'postgres',
  });
  root = await mkdtemp(path.join(tmpdir(), 'migrate-resume-'));
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await container?.stop();
  if (root) await rm(root, { recursive: true, force: true });
}, 30_000);

async function database(): Promise<string> {
  const name = 'migrate_resume_' + (++counter);
  await admin.query('CREATE DATABASE "' + name + '"');
  return name;
}
async function cleanup(name: string, dir: string): Promise<void> {
  await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
  await rm(dir, { recursive: true, force: true });
}
async function directory(): Promise<string> {
  const dir = path.join(root, 'case-' + counter + '-' + Date.now());
  await mkdir(dir, { recursive: true });
  return dir;
}
async function migration(dir: string, name: string, sql: string): Promise<void> {
  await writeFile(path.join(dir, name), sql, 'utf8');
}
function run(db: string, dir: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script, '--migrations-only'], {
      env: {
        ...process.env, DB_HOST: container.getHost(), DB_NAME: db, DB_USER: 'postgres',
        PGPORT: String(container.getPort()), PGPASSWORD: 'postgres', MIGRATIONS_DIR: dir,
        SYNC_APP_PASSWORD: 'test-sync-app-password',
        DEVICE_ENROLLMENT_PASSWORD: 'test-device-enrollment-password',
        DEVICE_ADMIN_PASSWORD: 'test-device-admin-password',
        MAINTENANCE_PASSWORD: 'test-maintenance-password',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => { output += s; });
    child.stderr.setEncoding('utf8').on('data', (s: string) => { output += s; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
async function query(db: string, sql: string): Promise<any> {
  const pool = new Pool({
    host: container.getHost(), port: container.getPort(), database: db,
    user: 'postgres', password: 'postgres',
  });
  try {
    const r = await pool.query(sql);
    const value = r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
    return typeof value === 'string' && value !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : value;
  } finally { await pool.end(); }
}
async function ledger(db: string): Promise<string[]> {
  const pool = new Pool({
    host: container.getHost(), port: container.getPort(), database: db,
    user: 'postgres', password: 'postgres',
  });
  try {
    const r = await pool.query('SELECT filename FROM public.schema_migrations ORDER BY filename');
    return r.rows.map((x: { filename: string }) => x.filename);
  } finally { await pool.end(); }
}

describe('scripts/migrate.sh transactional resume on PostgreSQL 16', () => {
  it('rolls back 002 fully, resumes 002 and 003, and never replays 001', async () => {
    const db = await database(); const dir = await directory();
    try {
      await migration(dir, '001_base.sql', 'CREATE TABLE run_counter (n integer); INSERT INTO run_counter VALUES (1);');
      await migration(dir, '002_middle.sql', 'CREATE TABLE partial_002 (id integer); INSERT INTO partial_002 VALUES (2); SELECT 1 / 0;');
      await migration(dir, '003_last.sql', 'CREATE TABLE final_003 (id integer);');
      const failed = await run(db, dir);
      expect(failed.code).not.toBe(0);
      expect(await ledger(db)).toEqual(['001_base.sql']);
      expect(await query(db, 'SELECT n FROM run_counter')).toBe(1);
      expect(await query(db, "SELECT to_regclass('public.partial_002')")).toBeNull();
      expect(await query(db, "SELECT to_regclass('public.final_003')")).toBeNull();

      await migration(dir, '002_middle.sql', 'CREATE TABLE partial_002 (id integer); INSERT INTO partial_002 VALUES (2);');
      expect((await run(db, dir)).code).toBe(0);
      expect(await ledger(db)).toEqual(['001_base.sql', '002_middle.sql', '003_last.sql']);
      expect(await query(db, 'SELECT n FROM run_counter')).toBe(1);
      expect(await query(db, 'SELECT count(*) FROM partial_002')).toBe(1);
      expect((await run(db, dir)).code).toBe(0);
      expect(await query(db, 'SELECT n FROM run_counter')).toBe(1);
      expect(await ledger(db)).toEqual(['001_base.sql', '002_middle.sql', '003_last.sql']);
    } finally { await cleanup(db, dir); }
  }, 180_000);

  it('serializes two concurrent runs without duplicate migration effects or ledger rows', async () => {
    const db = await database(); const dir = await directory();
    try {
      const setup = new Pool({
        host: container.getHost(), port: container.getPort(), database: db,
        user: 'postgres', password: 'postgres',
      });
      await setup.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await setup.end();
      await migration(dir, '001_slow.sql', 'SELECT pg_sleep(1); CREATE TABLE run_once (n integer); INSERT INTO run_once VALUES (1);');
      await migration(dir, '002_next.sql', 'CREATE TABLE after_lock (id integer);');
      const results = await Promise.all([run(db, dir), run(db, dir)]);
      expect(results.map(x => x.code)).toEqual([0, 0]);
      expect(await query(db, 'SELECT count(*) FROM run_once')).toBe(1);
      expect(await ledger(db)).toEqual(['001_slow.sql', '002_next.sql']);
      expect(await query(db, 'SELECT count(*) FROM schema_migrations')).toBe(2);
    } finally { await cleanup(db, dir); }
  }, 180_000);

  it('fails cleanly for CREATE INDEX CONCURRENTLY and leaves that migration unrecorded', async () => {
    const db = await database(); const dir = await directory();
    try {
      await migration(dir, '001_table.sql', 'CREATE TABLE index_probe (id integer);');
      await migration(dir, '002_concurrent.sql', 'CREATE INDEX CONCURRENTLY index_probe_idx ON index_probe (id);');
      await migration(dir, '003_after.sql', 'CREATE TABLE must_not_run (id integer);');
      const result = await run(db, dir);
      expect(result.code).not.toBe(0);
      expect(await ledger(db)).toEqual(['001_table.sql']);
      expect(await query(db, "SELECT to_regclass('public.index_probe_idx')")).toBeNull();
      expect(await query(db, "SELECT to_regclass('public.must_not_run')")).toBeNull();
      expect(result.output).toMatch(/transaction block|cannot run inside a transaction/i);
    } finally { await cleanup(db, dir); }
  }, 180_000);
});
