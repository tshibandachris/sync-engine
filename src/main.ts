import { NestFactory } from '@nestjs/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { runBootGuards } from './boot-guards.js';
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
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });

  const app = await createApp(db, jwtSecret, storage);
  await app.listen(port);

  console.log('Sync engine listening on port ' + port);
}

const isDirectRun = process.argv[1]?.endsWith('main.js') ||
  process.argv[1]?.endsWith('main.ts');

if (isDirectRun) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}