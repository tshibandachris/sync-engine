const fs = require('fs');
const file = 'C:\\sync-engine\\test\\cursor-gaps.spec.ts';
let c = fs.readFileSync(file, 'utf8');
c = c.replace(/\r\n/g, '\n');

// 1. pullAll : accepter 201 (NestJS default POST)
c = c.replace(
  "expect(status, `pull failed: ${JSON.stringify(json)}`).toBe(200);",
  "expect(status, `pull failed: ${JSON.stringify(json)}`).toBe(201);"
);

// 2. pushCheckIn : deja < 300, pas de correction
// 3. Verifier s'il y a d'autres .toBe(200)
const count200 = (c.match(/\.toBe\(200\)/g) || []).length;
console.log('Occurrences restantes de .toBe(200) : ' + count200);

fs.writeFileSync(file, c, 'utf8');
console.log('[OK] statut pull corrige (200 -> 201)');
