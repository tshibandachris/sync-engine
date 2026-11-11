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

const USER = '00000000-0000-4000-8000-000000000010';
const AGENT = '00000000-0000-4000-8000-000000000002';
const TENANT = '00000000-0000-4000-8000-000000000001';
const AUDIENCE = 'authenticated';
const ISSUER = 'https://example.supabase.co/auth/v1';

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey: privateKey as KeyObject, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

async function sign(
  key: KeyObject,
  claims: Record<string, unknown>,
  alg: 'RS256' | 'HS256' = 'RS256',
  expiresIn = '5m',
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(USER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

describe('verifyToken — Supabase asymmetric JWKS', () => {
  it('accepts a valid RS256 token and maps agent_id + tenantId', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, {
      agent_id: AGENT,
      tenantId: TENANT,
      permissions: ['courrier:read'],
    });
    await expect(verifyToken(token, jwks, { audience: AUDIENCE, issuer: ISSUER }))
      .resolves.toEqual({
        agentId: AGENT,
        tenantId: TENANT,
        permissions: ['courrier:read'],
        serviceIds: [],
      });
  });

  it('rejects a token signed by a different key', async () => {
    const trusted = await makeKeys();
    const attacker = await makeKeys();
    const token = await sign(attacker.privateKey, { agent_id: AGENT, tenantId: TENANT });
    await expect(verifyToken(token, trusted.jwks, {
      audience: AUDIENCE, issuer: ISSUER,
    })).rejects.toBeInstanceOf(IdpVerificationError);
  });

  it('rejects a token without agent_id', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { tenantId: TENANT });
    await expect(verifyToken(token, jwks, {
      audience: AUDIENCE, issuer: ISSUER,
    })).rejects.toThrow(/agent_id/);
  });

  it('rejects a token without tenantId', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { agent_id: AGENT });
    await expect(verifyToken(token, jwks, {
      audience: AUDIENCE, issuer: ISSUER,
    })).rejects.toThrow(/tenantId/);
  });

  it('rejects malformed agent_id and tenantId UUIDs', async () => {
    const { privateKey, jwks } = await makeKeys();
    const badAgent = await sign(privateKey, { agent_id: 'not-a-uuid', tenantId: TENANT });
    const badTenant = await sign(privateKey, { agent_id: AGENT, tenantId: 'not-a-uuid' });
    await expect(verifyToken(badAgent, jwks, {
      audience: AUDIENCE, issuer: ISSUER,
    })).rejects.toThrow(/agent_id/);
    await expect(verifyToken(badTenant, jwks, {
      audience: AUDIENCE, issuer: ISSUER,
    })).rejects.toThrow(/tenantId/);
  });

  it('rejects HS256 even when the claims are otherwise valid', async () => {
    const { jwks } = await makeKeys();
    const secret = new TextEncoder().encode('a-test-secret-that-is-long-enough-for-hmac-signing');
    const token = await new SignJWT({ agent_id: AGENT, tenantId: TENANT })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(USER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    await expect(verifyToken(token, jwks, {
      audience: AUDIENCE, issuer: ISSUER,
    })).rejects.toBeInstanceOf(IdpVerificationError);
  });

  it('rejects wrong audience and issuer', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await sign(privateKey, { agent_id: AGENT, tenantId: TENANT });
    await expect(verifyToken(token, jwks, {
      audience: 'another-api', issuer: ISSUER,
    })).rejects.toBeInstanceOf(IdpVerificationError);
    await expect(verifyToken(token, jwks, {
      audience: AUDIENCE, issuer: 'https://wrong.example/',
    })).rejects.toBeInstanceOf(IdpVerificationError);
  });
});
