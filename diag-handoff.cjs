const fs = require('fs');
const file = 'C:\\sync-engine\\HANDOFF.md';
const c = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// Chercher le doublon
const dup = '    v0.5.1      Tenant write lock (cursor gaps fix)  60/60\n    v0.5.1      Tenant write lock (cursor gaps fix)  60/60';
console.log('Doublon v0.5.1 historique : ' + c.includes(dup));

// Vérifier les 11 points
const checks = {
  '1. Write serialisation dans archi': c.includes('**Write serialisation (tenant-level lock).**'),
  '2. tenant-write-lock.ts dans layout': c.includes('tenant-write-lock.ts'),
  '3. cursor-gaps.spec.ts dans layout': c.includes('cursor-gaps.spec.ts          (2 tests)'),
  '5. Roadmap v0.5.1 done': c.includes('### v0.5.1 — Tenant lock + cursor gaps fix (done)'),
  '5b. Roadmap v0.5.2 410': c.includes('### v0.5.2 — 410 GONE for stale cursors'),
  '6. RLS v0.5.3': c.includes('### v0.5.3 — Row-Level Security'),
  '7. S3 v0.5.4': c.includes('### v0.5.4 — S3 purge + orphan cleanup'),
  '8. Ligne cursor gaps retiree': !c.includes('| Cursor gaps in `sync_seq` |'),
  '9. Triggers Remove in v0.5.3': c.includes('Remove in v0.5.3.'),
  '11. RLS multi-tenancy -> v0.5.3': c.includes('**RLS is not enabled yet** — see Roadmap v0.5.3.'),
  '12. S3 attachments -> v0.5.4': c.includes('existence. See Roadmap v0.5.4.'),
  '14. 5 test files': c.includes('(5 test files, each'),
};

console.log('');
for (const [k, v] of Object.entries(checks)) {
  console.log((v ? 'OK   : ' : 'MANQUE : ') + k);
}

// Compter les references
console.log('');
console.log('v0.5.2 total : ' + (c.match(/v0\.5\.2/g) || []).length);
console.log('v0.5.3 total : ' + (c.match(/v0\.5\.3/g) || []).length);
console.log('v0.5.4 total : ' + (c.match(/v0\.5\.4/g) || []).length);
