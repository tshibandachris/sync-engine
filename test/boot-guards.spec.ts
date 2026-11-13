import { describe, it, expect } from 'vitest';
import { runBootGuards, assertAuthStrategy, JWT_SECRET_PLACEHOLDER } from '../src/boot-guards.js';
describe('boot guards', () => {
 const base:NodeJS.ProcessEnv={NODE_ENV:'development',JWT_SECRET:'a'.repeat(48),DATABASE_URL:'postgres://x'};
 it('passes valid development configuration',()=>expect(()=>runBootGuards(base)).not.toThrow());
 it('rejects dev token minting in production',()=>expect(()=>runBootGuards({...base,NODE_ENV:'production',AUTH_ALLOW_DEV_TOKEN:'true',JWKS_URL:'https://idp.example/jwks',JWT_AUDIENCE:'authenticated',JWT_ISSUER:'https://idp.example/auth/v1'})).toThrow(/AUTH_ALLOW_DEV_TOKEN/));
 it('allows dev token minting outside production',()=>expect(()=>runBootGuards({...base,AUTH_ALLOW_DEV_TOKEN:'true'})).not.toThrow());
 it('rejects short and placeholder JWT secrets in development',()=>{expect(()=>runBootGuards({...base,JWT_SECRET:'short'})).toThrow(/at least 32/);expect(()=>runBootGuards({...base,JWT_SECRET:JWT_SECRET_PLACEHOLDER})).toThrow(/placeholder/);});
 it('rejects missing database URL',()=>{const e={...base} as NodeJS.ProcessEnv;delete e.DATABASE_URL;expect(()=>runBootGuards(e)).toThrow(/DATABASE_URL/);});
 it('rejects missing development JWT secret',()=>{const e={...base} as NodeJS.ProcessEnv;delete e.JWT_SECRET;expect(()=>runBootGuards(e)).toThrow(/JWT_SECRET/);});
 it('accepts production JWKS configuration without JWT_SECRET',()=>expect(()=>runBootGuards({NODE_ENV:'production',DATABASE_URL:'postgres://x',JWKS_URL:'https://idp.example/jwks',JWT_AUDIENCE:'authenticated',JWT_ISSUER:'https://idp.example/auth/v1'} as NodeJS.ProcessEnv)).not.toThrow());
 it('rejects JWT_SECRET in production even when JWKS is configured',()=>expect(()=>assertAuthStrategy({NODE_ENV:'production',JWKS_URL:'https://idp.example/jwks',JWT_AUDIENCE:'authenticated',JWT_ISSUER:'https://idp.example/auth/v1',JWT_SECRET:'a'.repeat(48)} as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET must not be set/));
 it('requires JWKS_URL in production',()=>expect(()=>assertAuthStrategy({NODE_ENV:'production',JWT_AUDIENCE:'authenticated',JWT_ISSUER:'https://idp.example/auth/v1'} as NodeJS.ProcessEnv)).toThrow(/JWKS_URL/));
 it('rejects shared-secret mode in production',()=>expect(()=>assertAuthStrategy({NODE_ENV:'production',JWKS_URL:'https://idp.example/jwks',JWT_AUDIENCE:'authenticated',JWT_ISSUER:'https://idp.example/auth/v1',AUTH_ALLOW_SHARED_SECRET:'true'} as NodeJS.ProcessEnv)).toThrow(/AUTH_ALLOW_SHARED_SECRET/));
 it('requires both audience and issuer in production',()=>{expect(()=>assertAuthStrategy({NODE_ENV:'production',JWKS_URL:'https://idp.example/jwks',JWT_ISSUER:'https://idp.example/auth/v1'} as NodeJS.ProcessEnv)).toThrow(/JWT_AUDIENCE/);expect(()=>assertAuthStrategy({NODE_ENV:'production',JWKS_URL:'https://idp.example/jwks',JWT_AUDIENCE:'authenticated'} as NodeJS.ProcessEnv)).toThrow(/JWT_ISSUER/);});
 it('accepts complete asymmetric JWKS production config',()=>expect(()=>assertAuthStrategy({NODE_ENV:'production',JWKS_URL:'https://idp.example/jwks',JWT_AUDIENCE:'authenticated',JWT_ISSUER:'https://idp.example/auth/v1'} as NodeJS.ProcessEnv)).not.toThrow());
});
