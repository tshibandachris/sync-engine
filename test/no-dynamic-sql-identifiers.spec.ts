import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Drizzle < 0.45.2 echappait mal les identifiants SQL (GHSA-gpj5-g38j-94v9). Meme corrigee,
// une entree utilisateur ne doit jamais devenir un identifiant : ces API sont donc interdites
// sans revue. Pour en ajouter une legitime, liste le fichier ici avec la raison.
const ALLOWED: Record<string, string> = {};

const FORBIDDEN: Array<[string, RegExp]> = [
  ['sql.identifier', /\bsql\.identifier\s*\(/],
  ['sql.raw', /\bsql\.raw\s*\(/],
  ['.as(', /\.as\s*\(/],
  ['sql.join', /\bsql\.join\s*\(/],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('API Drizzle a identifiants dynamiques', () => {
  it("n'apparaissent nulle part dans src sans revue explicite", () => {
    const hits: string[] = [];
    for (const file of walk('src')) {
      const key = file.replaceAll('\\', '/');
      if (ALLOWED[key]) continue;
      const text = readFileSync(file, 'utf8');
      for (const [label, re] of FORBIDDEN) {
        if (re.test(text)) hits.push(key + ': ' + label);
      }
    }
    expect(hits).toEqual([]);
  });
});
