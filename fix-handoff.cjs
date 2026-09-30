const fs = require('fs');
const file = 'C:\\sync-engine\\HANDOFF.md';
let c = fs.readFileSync(file, 'utf8');
c = c.replace(/\r\n/g, '\n');

let changed = 0;
function replaceOnce(from, to, label) {
  if (!c.includes(from)) {
    console.log('SKIP : ' + label);
    return;
  }
  c = c.replace(from, to);
  changed++;
  console.log('OK   : ' + label);
}

// ============================================================
// 1. Remplacer le bloc "Known bug" par le bloc "Write serialisation"
// ============================================================
const oldBug = `**Known bug — cursor gaps.** \`nextval\` is not transactional. A
transaction that obtains seq 100 can commit after one that obtained
seq 101. A client that pulls in between sees 101, advances its cursor
to 101, and never sees 100. The current advisory lock serialises by
\`(agent, idempotency_key)\` pair, not by tenant, so two agents of the
same tenant can write concurrently. **This is a data-loss bug and
must be fixed before production.** See Roadmap v0.5.1.`;

const newBug = `**Write serialisation (tenant-level lock).**

Every code path that writes to a \`sync_seq\`-bearing table takes a
tenant-level advisory lock for the whole transaction:

    SELECT pg_advisory_xact_lock(7301, hashtext('<tenant_id>'))

- Constant namespace \`7301\` — disjoint from the idempotency locks and
  from the test gate key in \`test/cursor-gaps.spec.ts\` (424242).
- Helper: \`src/tenant-write-lock.ts\` → \`lockTenantWrites(tx, tenantId)\`.
- Must be the **first statement** of the transaction, before the
  per-(agent, key) idempotency lock and before any INSERT/UPDATE that
  fires the \`sync_seq\` trigger.
- Paths that take it: \`SyncPushService.pushChanges\`,
  \`SyncConflictService.resolveConflict\` (only when resolution is
  \`client\`, which writes to \`check_ins\`).
- Path that does **not** take it: \`SyncMaintenanceService.purge\` — it
  only touches \`sync_conflicts\` and \`sync_idempotency_keys\`, neither
  of which carries a \`sync_seq\` column.

**Why:** \`nextval('global_sync_seq')\` is not transactional. Without a
lock, a transaction that obtains seq N can commit after one that
obtained seq N+1, leaving a gap. A client pulling between the two
commits advances past the gap and never sees the earlier row.

**Cost:** all pushes of a single tenant are serialised. At 10k agents
on the same tenant, a peak at shift start becomes a queue. Documented
trade-off for correctness. The alternative is a transactional outbox
fed by a non-cached sequence — a larger refactor, deliberately
deferred.`;

replaceOnce(oldBug, newBug, '1. Known bug -> Write serialisation');

// ============================================================
// 2. Ajouter tenant-write-lock.ts dans Project layout
// ============================================================
replaceOnce(
  "      attachment-storage.ts\n      sync.controller.ts",
  "      attachment-storage.ts\n      tenant-write-lock.ts\n      sync.controller.ts",
  '2. tenant-write-lock.ts dans layout'
);

// ============================================================
// 3. Ajouter cursor-gaps.spec.ts dans Project layout
// ============================================================
replaceOnce(
  "      attachments.http.spec.ts     (11 tests)\n      helpers/testcontainers-pg.ts",
  "      attachments.http.spec.ts     (11 tests)\n      cursor-gaps.spec.ts          (2 tests)\n      helpers/testcontainers-pg.ts",
  '3. cursor-gaps.spec.ts dans layout'
);

// ============================================================
// 4. Ajouter v0.5.1 dans Version history
// ============================================================
replaceOnce(
  "    v0.5        Attachments (S3)                     58/58",
  "    v0.5        Attachments (S3)                     58/58\n    v0.5.1      Tenant write lock (cursor gaps fix)  60/60",
  '4. v0.5.1 dans historique'
);

// ============================================================
// 5. Remplacer la section Roadmap v0.5.1 (longue) par version courte
// ============================================================
const oldRoadmap = `### v0.5.1 — Fix cursor gaps (critical, before any production use)

Root cause: \`nextval\` is not transactional. Two concurrent writes
in the same tenant can commit out of order.

Options considered:

1. Tenant-level advisory lock held for the whole write transaction.
2. Switch the pull cursor to \`xmin\` (transactional by nature).
3. Transactional outbox table feeding the sync stream.

Test that must exist before the fix: two parallel transactions that
force an out-of-order commit, one client pulling in between, assert
the earlier row is still delivered.`;

const newRoadmap = `### v0.5.1 — Tenant lock + cursor gaps fix (done)

Implemented. See the "Write serialisation" block above.

- \`src/tenant-write-lock.ts\` — \`lockTenantWrites(tx, tenantId)\`.
- Applied in \`SyncPushService.pushChanges\` and
  \`SyncConflictService.resolveConflict\`.
- Regression test: \`test/cursor-gaps.spec.ts\`. Red before the fix,
  green after. Log line \`B finished while A was still open\` flips
  from \`true\` to \`false\`.

### v0.5.2 — 410 GONE for stale cursors

The purge function (v0.3.3) deletes rows older than retention. A
client offline longer than retention never learns those rows were
deleted.

Design:

- The purge records a \`purged_up_to_seq\` per tenant. Table:
  \`sync_purge_state(tenant_id UUID PRIMARY KEY, purged_up_to_seq BIGINT, updated_at BIGINT)\`.
- \`/sync/pull\` returns \`410 GONE\` when
  \`last_pulled_at < purged_up_to_seq\` for the requesting tenant.
- Client must resync from scratch (full pull, no cursor).
- Retention policy documented in the API contract.

Regression test: a client pulls with a cursor below
\`purged_up_to_seq\` and receives 410.`;

replaceOnce(oldRoadmap, newRoadmap, '5. Roadmap v0.5.1 -> done + v0.5.2 410');

// ============================================================
// 6. Renumeroter : v0.5.2 RLS -> v0.5.3
// ============================================================
replaceOnce(
  "### v0.5.2 — Row-Level Security",
  "### v0.5.3 — Row-Level Security",
  '6. RLS : v0.5.2 -> v0.5.3'
);

// ============================================================
// 7. Renumeroter : v0.5.3 S3 -> v0.5.4
// ============================================================
replaceOnce(
  "### v0.5.3 — S3 purge + orphan cleanup",
  "### v0.5.4 — S3 purge + orphan cleanup",
  '7. S3 purge : v0.5.3 -> v0.5.4'
);

// ============================================================
// 8. Supprimer la ligne cursor gaps du tableau de dettes
// ============================================================
replaceOnce(
  "| Cursor gaps in \`sync_seq\` | **Critical** | Non-transactional \`nextval\`. Data loss possible. Fix in v0.5.1. |\n",
  "",
  '8. Suppression ligne cursor gaps du tableau dettes'
);

// ============================================================
// 9. Renumeroter la reference "Remove in v0.5.2" -> v0.5.3
// ============================================================
replaceOnce(
  "Masks the exact bug RLS should reveal. Remove in v0.5.2.",
  "Masks the exact bug RLS should reveal. Remove in v0.5.3.",
  '9. Reference v0.5.2 -> v0.5.3 (triggers)'
);

// ============================================================
// 10. Renumeroter les references v0.5.3 (S3) -> v0.5.4
// ============================================================
const cBefore10 = c;
c = c.split('are not cleaned up. v0.5.3.').join('are not cleaned up. v0.5.4.');
c = c.split('Objects stay in bucket forever. v0.5.3.').join('Objects stay in bucket forever. v0.5.4.');
if (c !== cBefore10) {
  changed++;
  console.log('OK   : 10. References S3 v0.5.3 -> v0.5.4');
} else {
  console.log('SKIP : 10. References S3 v0.5.3 -> v0.5.4');
}

// ============================================================
// 11. Renumeroter la reference RLS dans la section Multi-tenancy
// ============================================================
replaceOnce(
  "**RLS is not enabled yet** — see Roadmap v0.5.2.",
  "**RLS is not enabled yet** — see Roadmap v0.5.3.",
  '11. Reference RLS v0.5.2 -> v0.5.3 (multi-tenancy)'
);

// ============================================================
// 12. Renumeroter la reference S3 dans la section Attachments
// ============================================================
replaceOnce(
  "existence. See Roadmap v0.5.3.",
  "existence. See Roadmap v0.5.4.",
  '12. Reference S3 v0.5.3 -> v0.5.4 (attachments)'
);

// ============================================================
// 13. Renumeroter la reference "v0.5.3." dans le tableau de dettes (upload)
// ============================================================
replaceOnce(
  "HEAD \`confirm\` must reject on mismatch. |",
  "HEAD \`confirm\` must reject on mismatch. v0.5.4. |",
  '13. Upload validation -> v0.5.4'
);

// ============================================================
// 14. Quick start : "4 test files" -> "5 test files"
// ============================================================
replaceOnce(
  "Subsequent test runs take ~90s end to end (4 test files, each",
  "Subsequent test runs take ~120s end to end (5 test files, each",
  '14. 4 -> 5 test files'
);

// ============================================================
// 15. Renumeroter les references "v0.5.2" restantes (RLS)
// ============================================================
const remaining = (c.match(/v0\.5\.2/g) || []).length;
console.log('');
console.log('References v0.5.2 restantes : ' + remaining);
console.log('References v0.5.3 restantes : ' + (c.match(/v0\.5\.3/g) || []).length);
console.log('References v0.5.4 restantes : ' + (c.match(/v0\.5\.4/g) || []).length);

fs.writeFileSync(file, c, 'utf8');
console.log('');
console.log('Total modifications appliquees : ' + changed);
