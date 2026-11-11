/**
 * Auth strategy configuration.
 * JWKS mode is mandatory in production; local JWT_SECRET verification is dev-only.
 */
export interface IdpConfig {
  mode: 'jwks' | 'dev-secret';
  jwksUrl?: string;
  audience?: string;
  issuer?: string;
  jwtSecret?: string;
}

export function readIdpConfig(env: NodeJS.ProcessEnv = process.env): IdpConfig {
  const jwksUrl = env.JWKS_URL?.trim() || undefined;
  const audience = env.JWT_AUDIENCE?.trim() || undefined;
  const issuer = env.JWT_ISSUER?.trim() || undefined;
  const jwtSecret = env.JWT_SECRET?.trim() || undefined;

  if (jwksUrl) return { mode: 'jwks', jwksUrl, audience, issuer };
  return { mode: 'dev-secret', jwtSecret };
}
