import { describe, it, expect } from 'vitest';
import {
  runBootGuards,
  assertAuthStrategy,
  JWT_SECRET_PLACEHOLDER,
} from '../src/boot-guards.js';

describe('boot guards', () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    JWT_SECRET: 'a'.repeat(48),
    DATABASE_URL: 'postgres://x',
  };

  it('passes for a valid development configuration', () => {
    expect(() => runBootGuards(base)).not.toThrow();
  });

  it('rejects AUTH_ALLOW_DEV_TOKEN=true when NODE_ENV=production', () => {
    expect(() =>
      runBootGuards({
        ...base,
        NODE_ENV: 'production',
        AUTH_ALLOW_DEV_TOKEN: 'true',
        JWKS_URL: 'https://idp.example/jwks',
        JWT_AUDIENCE: 'sync-engine',
      }),
    ).toThrow(/AUTH_ALLOW_DEV_TOKEN/);
  });

  it('allows AUTH_ALLOW_DEV_TOKEN=true outside production', () => {
    expect(() =>
      runBootGuards({ ...base, AUTH_ALLOW_DEV_TOKEN: 'true' }),
    ).not.toThrow();
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() =>
      runBootGuards({ ...base, JWT_SECRET: 'short' }),
    ).toThrow(/at least 32/);
  });

  it('rejects the .env.example JWT_SECRET placeholder', () => {
    expect(() =>
      runBootGuards({ ...base, JWT_SECRET: JWT_SECRET_PLACEHOLDER }),
    ).toThrow(/placeholder/);
  });

  it('rejects a missing DATABASE_URL', () => {
    const env = { ...base } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    expect(() => runBootGuards(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects a missing JWT_SECRET', () => {
    const env = { ...base } as NodeJS.ProcessEnv;
    delete env.JWT_SECRET;
    expect(() => runBootGuards(env)).toThrow(/JWT_SECRET/);
  });

  it('rejects AUTH_ALLOW_DEV_TOKEN=true in production only, not in staging', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      AUTH_ALLOW_DEV_TOKEN: 'true',
      JWKS_URL: 'https://idp.example/jwks',
      JWT_AUDIENCE: 'sync-engine',
    } as NodeJS.ProcessEnv;
    const staging = {
      ...base,
      NODE_ENV: 'staging',
      AUTH_ALLOW_DEV_TOKEN: 'true',
    } as NodeJS.ProcessEnv;

    expect(() => runBootGuards(prod)).toThrow(/AUTH_ALLOW_DEV_TOKEN/);
    expect(() => runBootGuards(staging)).not.toThrow();
  });

  it('requires JWKS_URL in production', () => {
    expect(() =>
      assertAuthStrategy({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/db',
        JWT_SECRET: 'a'.repeat(48),
        JWT_AUDIENCE: 'sync-engine',
      } as NodeJS.ProcessEnv),
    ).toThrow(/JWKS_URL/);
  });

  it('requires JWT_AUDIENCE in production when JWKS_URL is set', () => {
    expect(() =>
      assertAuthStrategy({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/db',
        JWKS_URL: 'https://idp.example/jwks',
      } as NodeJS.ProcessEnv),
    ).toThrow(/JWT_AUDIENCE/);
  });
});
