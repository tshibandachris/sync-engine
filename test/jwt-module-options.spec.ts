import { describe, expect, it } from 'vitest';
import { createJwtModuleOptions } from '../src/jwt-module-options.js';

describe('JwtModule configuration', () => {
  it('starts production configuration without JWT_SECRET and excludes HS256', () => {
    const options = createJwtModuleOptions({ NODE_ENV: 'production', JWT_SECRET: undefined });
    expect(options.secret).toBeUndefined();
    expect(options.signOptions?.algorithm).toBe('RS256');
    expect(options.verifyOptions?.algorithms).toEqual(['ES256', 'RS256']);
    expect(options.verifyOptions?.algorithms).not.toContain('HS256');
  });
  it('refuses a defined JWT_SECRET in production', () => {
    expect(() => createJwtModuleOptions({ NODE_ENV: 'production', JWT_SECRET: 'present' }))
      .toThrow(/JWT_SECRET must not be set in production/);
  });
  it('preserves development HS256 behavior', () => {
    const options = createJwtModuleOptions({ NODE_ENV: 'development', JWT_SECRET: 'development-secret' });
    expect(options.secret).toBe('development-secret');
    expect(options.signOptions?.algorithm).toBe('HS256');
    expect(options.verifyOptions?.algorithms).toEqual(['HS256']);
  });
});
