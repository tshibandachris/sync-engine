import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifyOptions {
  audience?: string;
  issuer?: string;
  tenantClaim: string;
}

export interface VerifiedIdentity {
  agentId: string;
  tenantId: string;
}

export class IdpVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdpVerificationError';
  }
}

/**
 * Verifies an IdP-issued token against the given JWKS resolver and extracts
 * the agent and tenant identities.
 *
 * Pure: no I/O of its own, no global state. The caller supplies the JWKS
 * resolver (remote in production, local in tests). Throws
 * IdpVerificationError on any failure — signature, expiry, audience,
 * issuer, or a missing/malformed sub or tenant claim.
 */
export async function verifyToken(
  token: string,
  jwks: JWTVerifyGetKey,
  options: VerifyOptions,
): Promise<VerifiedIdentity> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwks, {
      audience: options.audience,
      issuer: options.issuer,
    });
    payload = result.payload;
  } catch (err) {
    throw new IdpVerificationError(
      'Token verification failed: ' + (err as Error).message,
    );
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || !UUID_RE.test(sub)) {
    throw new IdpVerificationError('Token missing or invalid sub claim.');
  }

  const tenant = (payload as Record<string, unknown>)[options.tenantClaim];
  if (typeof tenant !== 'string' || !UUID_RE.test(tenant)) {
    throw new IdpVerificationError(
      'Token missing or invalid ' + options.tenantClaim + ' claim.',
    );
  }

  return { agentId: sub, tenantId: tenant };
}
