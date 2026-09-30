const fs = require('fs');
const file = 'C:\\sync-engine\\test\\helpers\\testcontainers-pg.ts';
let c = fs.readFileSync(file, 'utf8');
c = c.replace(/\r\n/g, '\n');

if (c.includes('008_sync_purge_state')) {
  console.log('INFO : helper deja patche');
  process.exit(0);
}

const oldRead = `  const migration7 = fs.readFileSync(
    path.join(migrationsDir, '007_attachments.sql'),
    'utf8',
  );`;
const newRead = oldRead + `

  const migration8 = fs.readFileSync(
    path.join(migrationsDir, '008_sync_purge_state.sql'),
    'utf8',
  );`;

if (!c.includes(oldRead)) {
  console.log('ERREUR : bloc migration7 introuvable');
  process.exit(1);
}
c = c.replace(oldRead, newRead);

const oldApply = '  await pool.query(migration7);';
const newApply = oldApply + '\n  await pool.query(migration8);';

if (!c.includes(oldApply)) {
  console.log('ERREUR : bloc await migration7 introuvable');
  process.exit(1);
}
c = c.replace(oldApply, newApply);

fs.writeFileSync(file, c, 'utf8');
console.log('OK : helper patche pour 008');
