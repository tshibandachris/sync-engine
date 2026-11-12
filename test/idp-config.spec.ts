import { describe, expect, it } from 'vitest';
import { readIdpConfig } from '../src/idp.config.js';

describe('identity provider configuration', () => {
  it('uses JWKS in production', () => {
    expect(readIdpConfig({ NODE_ENV: 'production', JWKS_URL: 'https://idp.example/jwks', JWT_AUDIENCE: 'authenticated', JWT_ISSUER: 'https://idp.example/auth/v1' } as NodeJS.ProcessEnv)).toMatchObject({ mode: 'jwks' });
  });
  it('never falls back to dev-secret mode in production', () => {
    expect(() => readIdpConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/JWKS_URL/);
  });
  it('preserves development shared-secret mode', () => {
    expect(readIdpConfig({ NODE_ENV: 'development', JWT_SECRET: 'local-development-secret' } as NodeJS.ProcessEnv)).toMatchObject({ mode: 'dev-secret', jwtSecret: 'local-development-secret' });
  });
});
