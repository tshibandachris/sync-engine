import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_IDP_ALGORITHMS = ['ES256', 'RS256'] as const;

export interface VerifyOptions {
  audience?: string;
  issuer?: string;
  /** @deprecated Tenant identity is always read from the fixed tenantId claim. */
  tenantClaim?: string;
}
export interface VerifiedIdentity { agentId: string; tenantId: string; permissions: string[]; serviceIds: string[]; }
export class IdpVerificationError extends Error {
  constructor(message: string) { super(message); this.name = 'IdpVerificationError'; }
}

/** Verify asymmetric OIDC/Supabase tokens. Business claims must be copied from
 * server-managed app_metadata by the provider hook, never from user_metadata. */
export async function verifyToken(token: string, jwks: JWTVerifyGetKey, options: VerifyOptions): Promise<VerifiedIdentity> {
  if (!options.audience?.trim() || !options.issuer?.trim()) throw new IdpVerificationError('Configured JWT audience and issuer are required.');
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwks, { algorithms: [...ALLOWED_IDP_ALGORITHMS], audience: options.audience, issuer: options.issuer });
    payload = result.payload;
  } catch (err) {
    throw new IdpVerificationError('Token verification failed: ' + (err as Error).message);
  }
  if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) throw new IdpVerificationError('Token missing or invalid sub claim.');
  const claims = payload as Record<string, unknown>;
  const agentId = claims.agent_id;
  if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) throw new IdpVerificationError('Token missing or invalid agent_id claim.');
  const tenantId = claims.tenantId;
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw new IdpVerificationError('Token missing or invalid tenantId claim.');
  const rawPermissions = claims.permissions;
  const rawScope = claims.scope;
  const permissions = Array.isArray(rawPermissions) ? rawPermissions.filter((v): v is string => typeof v === 'string') : typeof rawScope === 'string' ? rawScope.split(/\\s+/).filter(Boolean) : [];
  const rawServiceIds = claims.service_ids ?? claims.serviceIds;
  const serviceIds = Array.isArray(rawServiceIds) ? rawServiceIds.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)) : [];
  return { agentId, tenantId, permissions, serviceIds };
}
