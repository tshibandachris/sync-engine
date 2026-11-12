/**
 * Auth strategy configuration.
 *
 * Two modes:
 *   - 'jwks'       : verify tokens against a real identity provider's JWKS.
 *                    Required in production.
 *   - 'dev-secret' : verify tokens signed locally with JWT_SECRET. Dev only,
 *                    enforced by the boot guards.
 *
 * The mode is inferred from the environment: if JWKS_URL is set, we use
 * JWKS. Otherwise, in non-production, we fall back to the dev secret.
 */

export interface IdpConfig {
  mode: 'jwks' | 'dev-secret';
  /** Only in 'jwks' mode. */
  jwksUrl?: string;
  audience?: string;
  issuer?: string;
  /** Only in 'dev-secret' mode. */
  jwtSecret?: string;
}

export function readIdpConfig(env: NodeJS.ProcessEnv = process.env): IdpConfig {
  const jwksUrl = env.JWKS_URL?.trim() || undefined;
  const audience = env.JWT_AUDIENCE?.trim() || undefined;
  const issuer = env.JWT_ISSUER?.trim() || undefined;
  const jwtSecret = env.JWT_SECRET?.trim() || undefined;

  if (jwksUrl) {
    return { mode: 'jwks', jwksUrl, audience, issuer };
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('Production authentication requires JWKS_URL; dev-secret mode is disabled.');
  }

  return { mode: 'dev-secret', jwtSecret };
}
