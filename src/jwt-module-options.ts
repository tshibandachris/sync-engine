import type { JwtModuleOptions } from '@nestjs/jwt';

/**
 * Production verifies tokens through the remote JWKS guard. JwtService remains
 * registered for the development-only controller/guard injections, but has no
 * shared secret and cannot verify HS256 in production.
 */
export function createJwtModuleOptions(
  env: Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'JWT_SECRET'>,
  expiresIn: number | string = '30d',
): JwtModuleOptions {
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET !== undefined) throw new Error('JWT_SECRET must not be set in production.');
    return {
      signOptions: { algorithm: 'RS256', expiresIn: expiresIn as any },
      verifyOptions: { algorithms: ['ES256', 'RS256'] },
    };
  }
  const secret = env.JWT_SECRET?.trim();
  if (!secret) throw new Error('JWT_SECRET is required for development shared-secret authentication.');
  return {
    secret,
    signOptions: { algorithm: 'HS256', expiresIn: expiresIn as any },
    verifyOptions: { algorithms: ['HS256'] },
  };
}
