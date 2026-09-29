import { NestFactory } from '@nestjs/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { AppModule } from './app.module.js';

export async function createApp(
  db: NodePgDatabase<typeof schema>,
  jwtSecret: string,
) {
  const moduleRef = await NestFactory.create(
    AppModule.register({ db, jwtSecret }),
    { logger: false },
  );

  return moduleRef;
}

async function bootstrap(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  const port = Number(process.env.PORT ?? 3000);

  if (!databaseUrl) throw new Error('DATABASE_URL requis.');
  if (!jwtSecret) throw new Error('JWT_SECRET requis.');

  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const app = await createApp(db, jwtSecret);
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