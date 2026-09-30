const fs = require('fs');
const path = require('path');
const file = 'C:\\sync-engine\\src\\tenant-write-lock.ts';
let c = fs.readFileSync(file, 'utf8');
c = c.replace(/\r\n/g, '\n');

c = c.replace(
  "import { sql } from 'drizzle-orm';",
  "import { sql, type SQLWrapper } from 'drizzle-orm';"
);

c = c.replace(
  "export interface AdvisoryExecutor {\n  execute: (q: unknown) => Promise<unknown>;\n}",
  "export interface AdvisoryExecutor {\n  execute: (q: SQLWrapper) => Promise<unknown>;\n}"
);

fs.writeFileSync(file, c, 'utf8');
console.log('[OK] AdvisoryExecutor.execute : SQLWrapper');
