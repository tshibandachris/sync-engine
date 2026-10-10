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
 * Chooses between the two auth strategies and enforces the one the
 * environment asked for.
 *
 *   Production:  JWKS_URL and JWT_AUDIENCE are required. JWT_SECRET is not
 *                used (the app never signs tokens in production).
 *   Elsewhere:   if JWKS_URL is absent, fall back to a strong local
 *                JWT_SECRET so the dev mint at /auth/token works.
 */
export function assertAuthStrategy(env: NodeJS.ProcessEnv): void {
  const isProd = env.NODE_ENV === 'production';
  const jwksUrl = env.JWKS_URL?.trim();
  const audience = env.JWT_AUDIENCE?.trim();
  const allowSharedSecret = env.AUTH_ALLOW_SHARED_SECRET === 'true';

  if (isProd) {
    if (jwksUrl) {
      // IdP mode. The app never signs its own tokens; JWT_SECRET is unused.
      if (!audience) {
        throw new Error(
          'Boot guard: JWT_AUDIENCE is required when NODE_ENV=production ' +
            'and JWKS_URL is set.',
        );
      }
      return;
    }

    if (allowSharedSecret) {
      // Shared-secret mode, opted in explicitly. The operator accepts
      // that anyone holding JWT_SECRET can mint a token for any tenant.
      // /auth/token remains closed: tokens are minted offline with
      // scripts/mint-token.mjs.
      assertStrongJwtSecret(env);
      return;
    }

    throw new Error(
      'Boot guard: no auth strategy for NODE_ENV=production. ' +
        'Either set JWKS_URL (and JWT_AUDIENCE) to use an external IdP, ' +
        'or set AUTH_ALLOW_SHARED_SECRET=true to opt in to shared-secret ' +
        'mode. Shared-secret mode means JWT_SECRET alone grants access to ' +
        'every tenant; use it only on a trusted network.',
    );
  }

  // Non-production: unchanged.
  if (!jwksUrl) {
    assertStrongJwtSecret(env);
  }
}

/**
 * Runs every guard. Called by bootstrap() before the app listens.
 * Throws on the first violation.
 */
export function runBootGuards(env: NodeJS.ProcessEnv = process.env): void {
  assertDatabaseUrlPresent(env);
  // Order matters: the dev-token-in-production check gives the most specific
  // message. It runs before assertAuthStrategy, which would otherwise raise
  // a generic JWKS_URL error for the same misconfigured environment.
  assertNotDevAuthInProd(env);
  assertAuthStrategy(env);
}

/**
 * Config du serveur /metrics : port dédié (jamais celui de l'API) et token ops.
 * Refuse de démarrer si l'une des deux valeurs manque ou est un placeholder.
 */
export function assertMetricsConfig(env: NodeJS.ProcessEnv = process.env): { port: number; token: string } {
  const rawPort = env.METRICS_PORT;
  const port = Number(rawPort);
  if (!rawPort || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('METRICS_PORT est requis (entier entre 1 et 65535).');
  }
  if (env.PORT && port === Number(env.PORT)) {
    throw new Error("METRICS_PORT doit différer du port de l'API : /metrics ne doit pas être exposé sur le port public.");
  }
  const token = env.OPS_METRICS_TOKEN ?? '';
  if (token.length < 32) {
    throw new Error('OPS_METRICS_TOKEN est requis (32 caractères minimum).');
  }
  if (token.startsWith('change-me')) {
    throw new Error("OPS_METRICS_TOKEN a encore la valeur d'exemple de .env.example.");
  }
  return { port, token };
}
