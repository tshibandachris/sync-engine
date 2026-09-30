const fs = require('fs');
const file = 'C:\\sync-engine\\HANDOFF.md';
let c = fs.readFileSync(file, 'utf8');
c = c.replace(/\r\n/g, '\n');

const dup = '    v0.5.1      Tenant write lock (cursor gaps fix)  60/60\n    v0.5.1      Tenant write lock (cursor gaps fix)  60/60';
const single = '    v0.5.1      Tenant write lock (cursor gaps fix)  60/60';

if (c.includes(dup)) {
  c = c.replace(dup, single);
  fs.writeFileSync(file, c, 'utf8');
  console.log('OK   : doublon retire');
} else {
  console.log('SKIP : pas de doublon');
}
