import { describe, expect, it } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyObject,
} from 'jose';
import { IdpVerificationError, verifyToken } from '../src/idp-token.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const AGENT  = '00000000-0000-0000-0000-000000000002';
const AUDIENCE = 'sync-engine';
const ISSUER = 'https://idp.example/';
const TENANT_CLAIM = 'tenantId';

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey: privateKey as KeyObject, jwks };
}

async function sign(
  key: KeyObject,
  claims: Record<string, unknown>,
  expiresIn = '1h',
) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

describe('verifyToken', () => {
  it('accepts a valid token and returns the identity', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: AGENT, tenantId: TENANT });
    const id = await verifyToken(token, jwks, {
      audience: AUDIENCE,
      issuer: ISSUER,
      tenantClaim: TENANT_CLAIM,
    });
    expect(id).toEqual({ agentId: AGENT, tenantId: TENANT });
  });

  it('rejects an expired token', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: AGENT, tenantId: TENANT }, '-1s');
    await expect(
      verifyToken(token, jwks, { audience: AUDIENCE, issuer: ISSUER, tenantClaim: TENANT_CLAIM }),
    ).rejects.toBeInstanceOf(IdpVerificationError);
  });

  it('rejects a wrong audience', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: AGENT, tenantId: TENANT });
    await expect(
      verifyToken(token, jwks, { audience: 'other-api', issuer: ISSUER, tenantClaim: TENANT_CLAIM }),
    ).rejects.toBeInstanceOf(IdpVerificationError);
  });

  it('rejects a wrong issuer', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: AGENT, tenantId: TENANT });
    await expect(
      verifyToken(token, jwks, { audience: AUDIENCE, issuer: 'https://evil/', tenantClaim: TENANT_CLAIM }),
    ).rejects.toBeInstanceOf(IdpVerificationError);
  });

  it('rejects a token signed by a different key', async () => {
    const { jwks } = await makeKeys();
    const { privateKey: otherKey } = await makeKeys();
    const token = await sign(otherKey, { sub: AGENT, tenantId: TENANT });
    await expect(
      verifyToken(token, jwks, { audience: AUDIENCE, issuer: ISSUER, tenantClaim: TENANT_CLAIM }),
    ).rejects.toBeInstanceOf(IdpVerificationError);
  });

  it('rejects a missing tenant claim', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: AGENT });
    await expect(
      verifyToken(token, jwks, { audience: AUDIENCE, issuer: ISSUER, tenantClaim: TENANT_CLAIM }),
    ).rejects.toThrow(/tenantId/);
  });

  it('rejects a non-UUID sub claim', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: 'not-a-uuid', tenantId: TENANT });
    await expect(
      verifyToken(token, jwks, { audience: AUDIENCE, issuer: ISSUER, tenantClaim: TENANT_CLAIM }),
    ).rejects.toThrow(/sub/);
  });

  it('rejects a non-UUID tenant claim', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: AGENT, tenantId: 'not-a-uuid' });
    await expect(
      verifyToken(token, jwks, { audience: AUDIENCE, issuer: ISSUER, tenantClaim: TENANT_CLAIM }),
    ).rejects.toThrow(/tenantId/);
  });

  it('accepts a custom tenant claim name', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { sub: AGENT, 'https://sync/tenant': TENANT });
    const id = await verifyToken(token, jwks, {
      audience: AUDIENCE,
      issuer: ISSUER,
      tenantClaim: 'https://sync/tenant',
    });
    expect(id).toEqual({ agentId: AGENT, tenantId: TENANT });
  });
});
