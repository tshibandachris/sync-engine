// test-upload.mjs — flow upload/download contre la stack Docker.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { SignJWT } from 'jose';

const API = 'http://localhost:3000';
const TENANT  = '11111111-1111-1111-1111-111111111111';
const AGENT   = '22222222-2222-2222-2222-222222222222';
const SITE    = '33333333-3333-3333-3333-333333333333';
const MISSION = '44444444-4444-4444-4444-444444444444';
const CHECKIN = '55555555-5555-5555-5555-555555555555';

const COMPOSE = 'docker compose -f docker-compose.prod.yml --env-file .env.prod';

const step = (m) => console.log('\n--- ' + m + ' ---');
const ok   = (m) => console.log('OK   : ' + m);
const fail = (m) => { console.error('FAIL : ' + m); process.exit(1); };

// ----- 0. JWT -----
step('0. Mint JWT');
const env = fs.readFileSync('.env.prod', 'utf8');
const secretMatch = env.match(/^JWT_SECRET=(.*)$/m);
if (!secretMatch) fail('JWT_SECRET introuvable dans .env.prod');
const secret = secretMatch[1].trim();
if (secret.length < 32) fail('JWT_SECRET trop court');
const token = await new SignJWT({ sub: AGENT, tenantId: TENANT })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret));
ok('JWT signe (' + token.length + ' chars)');

// ----- 1. Seed -----
step('1. Seed SQL');
const now = Date.now();
const seedSql = `
DELETE FROM check_ins WHERE id = '${CHECKIN}';
DELETE FROM missions  WHERE id = '${MISSION}';
DELETE FROM sites     WHERE id = '${SITE}';

INSERT INTO sites (id, tenant_id, name, latitude, longitude, created_at, updated_at)
VALUES ('${SITE}', '${TENANT}', 'E2E test site', 0, 0, ${now}, ${now});

INSERT INTO missions (id, tenant_id, agent_id, site_id, title, created_at, updated_at)
VALUES ('${MISSION}', '${TENANT}', '${AGENT}', '${SITE}', 'E2E test mission', ${now}, ${now});

INSERT INTO check_ins (id, tenant_id, mission_id, agent_id, site_id,
                       check_in_time, check_in_lat, check_in_lng,
                       check_in_method, created_at, updated_at)
VALUES ('${CHECKIN}', '${TENANT}', '${MISSION}', '${AGENT}', '${SITE}',
        ${now}, 0, 0, 'manual', ${now}, ${now});
`;
const seedOut = execSync(
  COMPOSE + ' exec -T db psql -U postgres -d sync_engine -v ON_ERROR_STOP=1',
  { input: seedSql, encoding: 'utf8' },
);
console.log(seedOut.trim() || '(aucune sortie)');
ok('Seed insere');

// ----- 2. Fichier test : vrai JPEG 1x1 -----
step('2. Fichier test (vrai JPEG 1x1)');
const jpegBase64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
const fileBuffer = Buffer.from(jpegBase64, 'base64');
const sizeBytes = fileBuffer.length;
const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
const contentType = 'image/jpeg';
ok('taille=' + sizeBytes + ' bytes, sha256=' + checksum.slice(0, 16) + '...');

// ----- 3. POST request-upload -----
step('3. POST /attachments/request-upload');
const r1 = await fetch(API + '/attachments/request-upload', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    check_in_id: CHECKIN,
    content_type: contentType,
    size_bytes: sizeBytes,
    checksum_sha256: checksum,
  }),
});
const res1 = await r1.json();
console.log('status=' + r1.status);
console.log(JSON.stringify(res1, null, 2));
if (!r1.ok) fail('request-upload a echoue');

const uploadUrl    = res1.upload_url;
const attachmentId = res1.attachment_id;
if (!uploadUrl)    fail('upload_url absent de la reponse');
if (!attachmentId) fail('attachment_id absent de la reponse');
ok('upload_url + attachment_id extraits');
console.log('     upload_url = ' + uploadUrl.slice(0, 90) + '...');

// ----- 4. PUT -----
step('4. PUT vers SeaweedFS (via URL presignee)');
const put = await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': contentType },
  body: fileBuffer,
});
if (!put.ok) {
  console.log('status=' + put.status);
  console.log('body=' + (await put.text()));
  fail('PUT presigne a echoue');
}
ok('PUT ' + put.status);

// ----- 5. confirm -----
step('5. POST /attachments/' + attachmentId + '/confirm');
const r2 = await fetch(API + '/attachments/' + attachmentId + '/confirm', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token },
});
const res2 = await r2.json();
console.log('status=' + r2.status);
console.log(JSON.stringify(res2, null, 2));
if (!r2.ok) fail('confirm a echoue');
ok('confirm ' + r2.status);

// ----- 6. list -----
step('6. GET /attachments?check_in_id=' + CHECKIN);
const r3 = await fetch(API + '/attachments?check_in_id=' + CHECKIN, {
  headers: { Authorization: 'Bearer ' + token },
});
const res3 = await r3.json();
console.log('status=' + r3.status);
console.log(JSON.stringify(res3, null, 2));
if (!r3.ok) fail('list a echoue');

// La forme exacte de la reponse depend du service. Fallback simple.
const list = Array.isArray(res3) ? res3 : (res3.attachments ?? res3.items ?? []);
if (list.length === 0) fail('aucune piece jointe retournee');
const downloadUrl = list[0].download_url ?? list[0].downloadUrl ?? list[0].url;
if (!downloadUrl) fail('download_url absent de la reponse list');
ok('download_url extrait');
console.log('     download_url = ' + downloadUrl.slice(0, 90) + '...');

// ----- 7. GET download (bytes + sha256) -----
step('7. GET download_url (comparaison bytes + sha256)');
const get = await fetch(downloadUrl);
if (!get.ok) fail('GET download a echoue : ' + get.status);
const downloadedBuf = Buffer.from(await get.arrayBuffer());
const downloadedSha = crypto.createHash('sha256').update(downloadedBuf).digest('hex');

console.log('     source : size=' + sizeBytes       + ' sha256=' + checksum.slice(0, 16) + '...');
console.log('     cible  : size=' + downloadedBuf.length + ' sha256=' + downloadedSha.slice(0, 16) + '...');

if (downloadedBuf.length !== sizeBytes) fail('taille differente');
if (!downloadedBuf.equals(fileBuffer))  fail('contenu binaire different');
if (downloadedSha !== checksum)         fail('empreinte sha256 differente');

console.log('\n=== SUCCES : pipeline upload/download bout-en-bout ===');
