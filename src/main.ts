import { NestFactory } from '@nestjs/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { runBootGuards, assertMetricsConfig } from './boot-guards.js';
import { startMetricsServer, stopMetricsServer } from './observability/metrics-server.js';
import type { AttachmentStorage } from './attachment-storage.js';
import { S3AttachmentStorage } from './s3-attachment-storage.js';

export async function createApp(
  db: NodePgDatabase<typeof schema>,
  jwtSecret: string,
  storage: AttachmentStorage,
) {
  const moduleRef = await NestFactory.create(
    AppModule.register({ db, jwtSecret, storage }),
    { logger: false },
  );

  // Express derives req.ip from this setting. Keep proxy trust disabled by
  // default; production must set the exact number of trusted proxy hops.
  const expressApp = moduleRef.getHttpAdapter().getInstance() as {
    set?: (name: string, value: boolean | number) => void;
  };
  if (typeof expressApp.set === 'function') {
    const rawTrustProxyHops = process.env.TRUST_PROXY_HOPS;
    if (rawTrustProxyHops === undefined || rawTrustProxyHops.trim() === '') {
      expressApp.set('trust proxy', false);
    } else {
      const hops = Number(rawTrustProxyHops);
      if (!Number.isSafeInteger(hops) || hops < 0 || hops > 5) {
        throw new Error(
          'TRUST_PROXY_HOPS must be an integer from 0 to 5; use the exact trusted proxy count.',
        );
      }
      expressApp.set('trust proxy', hops === 0 ? false : hops);
    }
  }

  return moduleRef;
}

async function bootstrap(): Promise<void> {
  runBootGuards();

  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  const port = Number(process.env.PORT ?? 3000);

  if (!databaseUrl) throw new Error('DATABASE_URL requis.');
  if (!jwtSecret) throw new Error('JWT_SECRET requis.');

  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET requis.');

  const storage = new S3AttachmentStorage({
    bucket,
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    // Public host used to sign presigned URLs. Must be reachable by the
    // client that will PUT or GET. When unset, falls back to S3_ENDPOINT
    // (only useful inside the compose network). See HANDOFF.md.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });

  const app = await createApp(db, jwtSecret, storage);
  await app.listen(port);

  console.log('Sync engine listening on port ' + port);

  // Metrics on a dedicated port so /metrics is not reachable from the
  // public API. runBootGuards (above) already validated the config;
  // assertMetricsConfig returns the parsed values.
  const metricsConfig = assertMetricsConfig();
  const metricsServer = await startMetricsServer({
    port: metricsConfig.port,
    token: metricsConfig.token,
  });
  console.log('Metrics listening on port ' + metricsConfig.port);

  const shutdown = async (signal: string): Promise<void> => {
    console.log('Received ' + signal + ', shutting down.');
    try {
      await stopMetricsServer(metricsServer);
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const isDirectRun = process.argv[1]?.endsWith('main.js') ||
  process.argv[1]?.endsWith('main.ts');

if (isDirectRun) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}