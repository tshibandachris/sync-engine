/**
 * Runtime configuration guards.
 *
 * These run at process start, before any database connection or HTTP listener,
 * to fail fast on dangerous configurations. The alternative is a service that
 * boots successfully with dev credentials in production, which is exactly the
 * class of failure no test can catch.
 */

export const JWT_SECRET_PLACEHOLDER =
  'change-me-to-a-random-string-of-32-chars-min';

const MIN_JWT_SECRET_LENGTH = 32;

export function assertDatabaseUrlPresent(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_URL || env.DATABASE_URL.trim().length === 0) {
    throw new Error(
      'Boot guard: DATABASE_URL is required. Set it in the environment or .env file.',
    );
  }
}

export function assertStrongJwtSecret(env: NodeJS.ProcessEnv): void {
  const secret = env.JWT_SECRET;

  if (!secret || secret.length === 0) {
    throw new Error('Boot guard: JWT_SECRET is required.');
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      'Boot guard: JWT_SECRET must be at least ' +
        MIN_JWT_SECRET_LENGTH +
        ' characters (got ' +
        secret.length +
        '). Generate one with: openssl rand -base64 48',
    );
  }

  if (secret === JWT_SECRET_PLACEHOLDER) {
    throw new Error(
      'Boot guard: JWT_SECRET is still the .env.example placeholder. Replace it.',
    );
  }
}

export function assertNotDevAuthInProd(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production' && env.AUTH_ALLOW_DEV_TOKEN === 'true') {
    throw new Error(
      'Boot guard: AUTH_ALLOW_DEV_TOKEN=true is forbidden when NODE_ENV=production. ' +
        'This flag exposes /auth/token, which issues a valid token for any agent_id. ' +
        'Set AUTH_ALLOW_DEV_TOKEN=false in production.',
    );
  }
}

/**
 * Runs every guard. Called by bootstrap() before the app listens.
 * Throws on the first violation.
 */
export function runBootGuards(env: NodeJS.ProcessEnv = process.env): void {
  assertDatabaseUrlPresent(env);
  assertStrongJwtSecret(env);
  assertNotDevAuthInProd(env);
}
