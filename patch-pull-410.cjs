const fs = require('fs');
const file = 'C:\\sync-engine\\src\\sync-pull.service.ts';
let c = fs.readFileSync(file, 'utf8');
c = c.replace(/\r\n/g, '\n');

// 1. Import GoneException
if (!c.includes('GoneException')) {
  c = c.replace(
    "import { NodePgDatabase } from 'drizzle-orm/node-postgres';",
    "import { GoneException } from '@nestjs/common';\nimport { NodePgDatabase } from 'drizzle-orm/node-postgres';"
  );
  console.log('OK : import GoneException ajoute');
}

// 2. Insertion du bloc apres le SELECT
if (c.includes('Stale-cursor check')) {
  console.log('INFO : bloc deja insere');
  process.exit(0);
}

const anchor = '    `);\n\n    /*\n     * PostgreSQL retourne les BIGINT sous forme de string avec pg.';

if (!c.includes(anchor)) {
  console.log('ERREUR : ancre introuvable');
  process.exit(1);
}

const insertLines = [
  '',
  '    /*',
  '     * Stale-cursor check (v0.5.2).',
  '     *',
  '     * Must run AFTER the data read above. The purge removes tombstones and',
  '     * raises purged_up_to_seq in ONE transaction, so either it committed',
  '     * before our read (the watermark is visible here -> 410) or after it',
  '     * (our read still contained the tombstones). Cursor 0 is a full sync',
  '     * and is never stale, otherwise a client could never recover.',
  '     */',
  '    if (sinceSeq > 0) {',
  '      const purge = await this.db.execute(sql`',
  '        SELECT purged_up_to_seq',
  '        FROM sync_purge_state',
  '        WHERE tenant_id = ${tenantId}::uuid',
  '      `);',
  '      const raw = (purge.rows[0] as Record<string, unknown> | undefined)',
  '        ?.purged_up_to_seq;',
  '      const watermark = raw === null || raw === undefined ? 0 : Number(raw);',
  '',
  '      if (sinceSeq < watermark) {',
  '        throw new GoneException({',
  '          statusCode: 410,',
  "          error: 'Gone',",
  "          code: 'CURSOR_TOO_OLD',",
  '          message:',
  "            'Cursor predates purged history; resync from scratch (last_pulled_at = 0).',",
  '        });',
  '      }',
  '    }',
].join('\n');

const newAnchor = '    `);' + insertLines + '\n\n    /*\n     * PostgreSQL retourne les BIGINT sous forme de string avec pg.';
c = c.replace(anchor, newAnchor);

fs.writeFileSync(file, c, 'utf8');
console.log('OK : bloc 410 insere');
