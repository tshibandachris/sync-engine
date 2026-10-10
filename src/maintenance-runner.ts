import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { assertMaintenanceRole } from './maintenance-role.js';
import { S3AttachmentStorage } from './s3-attachment-storage.js';
import {
  runMaintenanceCycle,
  type MaintenanceReport,
} from './maintenance-orchestrator.js';

/**
 * CLI entry point for the maintenance cycle.
 *
 * Runs as a batch job, not as part of the API. Reads the same env vars
 * the API reads (DATABASE_URL, S3_*), builds its own pool and storage,
 * runs one cycle, prints the report as JSON on stdout, and exits.
 *
 * Exit code:
 *   0  every tenant succeeded, or the run was skipped because another
 *      runner held the advisory lock
 *   1  at least one tenant failed, or the process could not start
 *
 * Schedule it with systemd timer, a Kubernetes CronJob, or an
 * equivalent. See HANDOFF.md.
 */
export async function bootstrapMaintenance(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL requis.');
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET requis.');

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    // A statement stuck for good must fail loudly, not hold the lock forever.
    statement_timeout: Number(process.env.MAINTENANCE_STATEMENT_TIMEOUT_MS ?? 300_000),
  });
  pool.on('error', (err) => console.error('[maintenance] idle client error:', err));

  // Refuse to run as a role that bypasses RLS. A superuser or BYPASSRLS
  // role would make the purges touch every tenant without an error and
  // without a trace.
  await assertMaintenanceRole(pool);

  // Global deadline: a stuck run must end with exit code 1. Otherwise every later run
  // reports "skipped" (exit code 0) and the purge silently stops.
  const deadline = setTimeout(() => {
    console.error('[maintenance] deadline exceeded, aborting');
    process.exit(1);
  }, Number(process.env.MAINTENANCE_DEADLINE_MS ?? 3_600_000));
  deadline.unref();
  const db = drizzle(pool, { schema });
  const storage = new S3AttachmentStorage({
    bucket,
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });

  try {
    const report: MaintenanceReport = await runMaintenanceCycle({ pool, db, storage });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');

    if (!report.skipped && report.tenantsProcessed === 0) {
      console.error('[maintenance] warning: the tenants registry is empty, nothing was purged');
    }

    if (report.skipped) {
      // Not an error: the previous run is still going. The scheduler
      // will catch the next window.
      return 0;
    }
    return report.tenantsFailed > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith('maintenance-runner.js') ||
  process.argv[1]?.endsWith('maintenance-runner.ts');

if (isDirectRun) {
  bootstrapMaintenance()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
