// Mint a JWT for shared-secret mode, offline.
//
// Usage:
//   JWT_SECRET=... node scripts/mint-token.mjs <agent-uuid> <tenant-uuid>
//
// The output is printed on stdout; copy it into the client.
// This is the only supported way to obtain a token when
// AUTH_ALLOW_SHARED_SECRET=true: /auth/token stays closed in production.

import { SignJWT } from 'jose';

const [, , agentId, tenantId] = process.argv;

if (!agentId || !tenantId) {
  console.error('Usage: node scripts/mint-token.mjs <agent-uuid> <tenant-uuid>');
  process.exit(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(agentId) || !UUID_RE.test(tenantId)) {
  console.error('Both arguments must be UUIDs.');
  process.exit(1);
}

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error('JWT_SECRET must be set (32 chars min). Read it from .env.prod.');
  process.exit(1);
}

const key = new TextEncoder().encode(secret);
const token = await new SignJWT({ sub: agentId, tenantId })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('30d')
  .sign(key);

process.stdout.write(token + '\n');
