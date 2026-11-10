// Mint a short-lived, tenant-scoped device administrator JWT for shared-secret mode.
//
// Usage:
//   JWT_SECRET=... node scripts/mint-device-admin-token.mjs <actor-uuid> <tenant-uuid> <permission[,permission...]>
//
// This script is an offline operator tool. Never ship JWT_SECRET or the
// resulting token to a POS terminal. Tokens expire after 15 minutes.

import { SignJWT } from 'jose';

const [, , actorId, tenantId, rawPermissions] = process.argv;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = new Set([
  'devices:read',
  'devices:approve',
  'devices:reject',
  'devices:revoke',
]);

if (!actorId || !tenantId || !rawPermissions) {
  console.error(
    'Usage: JWT_SECRET=... node scripts/mint-device-admin-token.mjs <actor-uuid> <tenant-uuid> <permission[,permission...]>',
  );
  process.exit(1);
}
if (!UUID_RE.test(actorId) || !UUID_RE.test(tenantId)) {
  console.error('actor-uuid and tenant-uuid must be valid UUIDs.');
  process.exit(1);
}

const permissions = [...new Set(rawPermissions.split(',').map((value) => value.trim()).filter(Boolean))];
if (permissions.length === 0 || permissions.some((permission) => !ALLOWED.has(permission))) {
  console.error('Allowed permissions: ' + [...ALLOWED].join(', '));
  process.exit(1);
}

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error('JWT_SECRET must be set (32 chars min). Read it from the trusted deployment secret store.');
  process.exit(1);
}

const key = new TextEncoder().encode(secret);
const token = await new SignJWT({
  sub: actorId,
  tenantId,
  permissions,
  token_use: 'device_admin',
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(key);

process.stdout.write(token + '\n');
