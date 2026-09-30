import { describe, it, expect } from 'vitest';
import {
  runBootGuards,
  assertNotDevAuthInProd,
  assertStrongJwtSecret,
  assertDatabaseUrlPresent,
  JWT_SECRET_PLACEHOLDER,
} from '../src/boot-guards.js';

describe('boot guards', () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    JWT_SECRET: 'a'.repeat(32),
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
      }),
    ).toThrow(/AUTH_ALLOW_DEV_TOKEN/);
  });

  it('allows AUTH_ALLOW_DEV_TOKEN=true outside production', () => {
    expect(() =>
      runBootGuards({
        ...base,
        NODE_ENV: 'development',
        AUTH_ALLOW_DEV_TOKEN: 'true',
      }),
    ).not.toThrow();
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() =>
      runBootGuards({ ...base, JWT_SECRET: 'too-short' }),
    ).toThrow(/32 characters/);
  });

  it('rejects the .env.example JWT_SECRET placeholder', () => {
    expect(() =>
      runBootGuards({ ...base, JWT_SECRET: JWT_SECRET_PLACEHOLDER }),
    ).toThrow(/placeholder/);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() =>
      assertDatabaseUrlPresent({ ...base, DATABASE_URL: undefined }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects a missing JWT_SECRET', () => {
    expect(() =>
      assertStrongJwtSecret({ ...base, JWT_SECRET: undefined }),
    ).toThrow(/JWT_SECRET is required/);
  });

  it('rejects AUTH_ALLOW_DEV_TOKEN=true in production only, not in staging', () => {
    expect(() =>
      assertNotDevAuthInProd({
        ...base,
        NODE_ENV: 'staging',
        AUTH_ALLOW_DEV_TOKEN: 'true',
      }),
    ).not.toThrow();
  });
});
