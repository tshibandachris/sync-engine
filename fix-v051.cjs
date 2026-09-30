const fs = require('fs');
const path = require('path');
const root = 'C:\\sync-engine';

// ============================================================
// 1. Create src/tenant-write-lock.ts
// ============================================================
const lockFile = `import { sql } from 'drizzle-orm';

// Namespace constant. Must differ from:
//   - idempotency locks (pg_advisory_xact_lock(hashtext(agentId || ':' || key)))
//   - the test gate key in test/cursor-gaps.spec.ts (424242)
// The 2-arg variant and the 1-arg variant use disjoint int8 spaces.
const TENANT_WRITE_LOCK_NS = 7301;

export interface AdvisoryExecutor {
  execute: (q: unknown) => Promise<unknown>;
}

/**
 * Serialises all sync_seq-producing writes of one tenant until commit.
 * Must be the FIRST statement of the transaction, before any INSERT/UPDATE
 * that fires the sync_seq trigger, and before any per-(agent, key)
 * idempotency lock.
 *
 * Why: nextval('global_sync_seq') is not transactional. A transaction that
 * obtains seq N can commit after one that obtained seq N+1, leaving a gap
 * in the visible sequence. A client pulling in between advances past the
 * gap and never sees the earlier row.
 */
export async function lockTenantWrites(
  tx: AdvisoryExecutor,
  tenantId: string,
): Promise<void> {
  await tx.execute(
    sql\`SELECT pg_advisory_xact_lock(\${TENANT_WRITE_LOCK_NS}::int, hashtext(\${tenantId}::text))\`,
  );
}
`;

fs.writeFileSync(path.join(root, 'src', 'tenant-write-lock.ts'), lockFile, 'utf8');
console.log('[OK] src/tenant-write-lock.ts');

// ============================================================
// 2. Patch sync-push.service.ts
// ============================================================
const pushPath = path.join(root, 'src', 'sync-push.service.ts');
let push = fs.readFileSync(pushPath, 'utf8');
push = push.replace(/\r\n/g, '\n');

// 2a. Import
if (!push.includes('tenant-write-lock')) {
  push = push.replace(
    "import * as schema from './schema.js';",
    "import * as schema from './schema.js';\nimport { lockTenantWrites } from './tenant-write-lock.js';"
  );
}

// 2b. Take the lock first statement of the transaction
const oldPushTx = '    return await this.db.transaction(async (tx) => {\n      if (idempotencyKey) {';
const newPushTx = '    return await this.db.transaction(async (tx) => {\n      await lockTenantWrites(tx, tenantId);\n\n      if (idempotencyKey) {';

if (push.includes(oldPushTx)) {
  push = push.replace(oldPushTx, newPushTx);
  fs.writeFileSync(pushPath, push, 'utf8');
  console.log('[OK] sync-push.service.ts patche');
} else if (push.includes('await lockTenantWrites(tx, tenantId)')) {
  console.log('[INFO] sync-push.service.ts deja patche');
} else {
  console.log('[ERREUR] sync-push.service.ts : ancre introuvable');
}

// ============================================================
// 3. Patch sync-conflict.service.ts
// ============================================================
const conflictPath = path.join(root, 'src', 'sync-conflict.service.ts');
let conflict = fs.readFileSync(conflictPath, 'utf8');
conflict = conflict.replace(/\r\n/g, '\n');

// 3a. Import
if (!conflict.includes('tenant-write-lock')) {
  conflict = conflict.replace(
    "import * as schema from './schema.js';",
    "import * as schema from './schema.js';\nimport { lockTenantWrites } from './tenant-write-lock.js';"
  );
}

// 3b. Take the lock first statement of the transaction
const oldConflictTx = '    await this.db.transaction(async (tx) => {\n      const locked = await tx.execute(sql`';
const newConflictTx = '    await this.db.transaction(async (tx) => {\n      await lockTenantWrites(tx, tenantId);\n\n      const locked = await tx.execute(sql`';

if (conflict.includes(oldConflictTx)) {
  conflict = conflict.replace(oldConflictTx, newConflictTx);
  fs.writeFileSync(conflictPath, conflict, 'utf8');
  console.log('[OK] sync-conflict.service.ts patche');
} else if (conflict.includes('await lockTenantWrites(tx, tenantId)')) {
  console.log('[INFO] sync-conflict.service.ts deja patche');
} else {
  console.log('[ERREUR] sync-conflict.service.ts : ancre introuvable');
}

// ============================================================
// 4. Report
// ============================================================
console.log('');
console.log('=== Verifications ===');
const p = fs.readFileSync(pushPath, 'utf8');
const c = fs.readFileSync(conflictPath, 'utf8');
console.log('push import  : ' + p.includes("import { lockTenantWrites }"));
console.log('push call    : ' + p.includes("await lockTenantWrites(tx, tenantId)"));
console.log('confl import : ' + c.includes("import { lockTenantWrites }"));
console.log('confl call   : ' + c.includes("await lockTenantWrites(tx, tenantId)"));
console.log('');
console.log('maintenance  : inchange (pas de sync_seq dans les tables purgees)');
