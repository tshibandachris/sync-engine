// test/orphan-site-reassignment.spec.ts
//
// Bug 1 : après réaffectation d'une mission de A vers B, le site A disparaît du pull
// alors que des check-ins historiques y renvoient (perte silencieuse de contexte).
//
// Invariant : tant qu'un agent a un check-in rattaché au site A, le site A
// reste dans son pull, même si la mission a été déplacée.
//
// Commit 1 : ce fichier. Le test « it.fails » passe tant que le bug existe.
// Commit 2 : migration 013 + schéma + push + pull, puis retrait de ".fails".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET } from './helpers/jwt.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { SyncController } from '../src/sync.controller.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
});

describe('Bug 1 : site orphelin après réaffectation de mission', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let baseUrl: string;

  const tenantId = randomUUID();

  const tokenFor = (agentId: string) => jwt.sign({ sub: agentId, tenantId });

  async function http(path: string, tokenValue: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + tokenValue,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  const checkInRow = (id: string, missionId: string) => ({
    id,
    mission_id: missionId,
    check_in_time: 1700000000000,
    check_in_lat: 48.85,
    check_in_lng: 2.35,
    check_in_method: 'GPS',
  });

  const pushCheckIn = (tokenValue: string, row: ReturnType<typeof checkInRow>) =>
    http('/sync/push', tokenValue, { changes: { check_ins: { created: [row] } } }, { 'Idempotency-Key': randomUUID() });

  // Pull complet depuis 0 ; renvoie les ids de sites reçus
  async function pullSiteIds(tokenValue: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor = 0;
    for (let i = 0; i < 100; i++) {
      const { status, json } = await http('/sync/pull', tokenValue, { last_pulled_at: cursor, limit: 500 });
      expect(status, 'pull failed: ' + JSON.stringify(json)).toBe(201);
      const sites = json.changes?.sites ?? { created: [], updated: [] };
      for (const row of [...(sites.created ?? []), ...(sites.updated ?? [])]) ids.add(row.id);
      cursor = json.timestamp;
      if (!json.has_more) break;
    }
    return ids;
  }

  // Un scénario isolé par test (ids neufs), seed en SQL comme cursor-gaps
  async function setupScenario() {
    const agentId = randomUUID();
    const siteA = randomUUID();
    const siteB = randomUUID();
    const missionId = randomUUID();

    for (const [id, name] of [[siteA, 'site-A'], [siteB, 'site-B']] as const) {
      await pg.pool.query(
        'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)',
        [id, tenantId, name, 0, 0],
      );
    }
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionId, tenantId, agentId, 'mission-orphan-test', siteA],
    );

    // Le check-in passe par le vrai push : c'est ce chemin que le fix modifie
    const push = await pushCheckIn(tokenFor(agentId), checkInRow(randomUUID(), missionId));
    expect(push.status, 'push failed: ' + JSON.stringify(push.json)).toBeLessThan(300);

    return { agentId, siteA, siteB, missionId };
  }

  async function reassign(missionId: string, toSite: string) {
    const r = await pg.pool.query('UPDATE missions SET site_id = $1 WHERE id = $2', [toSite, missionId]);
    expect(r.rowCount).toBe(1);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '30d' },
        }),
      ],
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    jwt = moduleRef.get(JwtService);
    await app.listen(0);
    baseUrl = 'http://127.0.0.1:' + (app.getHttpServer().address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // Garde-fou 1 : le scénario est bien monté (vert avant ET après le fix)
  it('avant réaffectation, le pull contient le site A', async () => {
    const { agentId, siteA } = await setupScenario();
    expect(await pullSiteIds(tokenFor(agentId))).toContain(siteA);
  });

  // Garde-fou 2 : après réaffectation, le site B arrive bien. Il isole la
  // cause de l'échec du test rouge : seule l'absence de A doit le faire échouer.
  it('après réaffectation de M vers B, le pull contient le site B', async () => {
    const { agentId, siteB, missionId } = await setupScenario();
    await reassign(missionId, siteB);
    expect(await pullSiteIds(tokenFor(agentId))).toContain(siteB);
  });

  // LE TEST ROUGE
  it.fails('après réaffectation de M vers B, le pull contient encore le site A', async () => {
    const { agentId, siteA, missionId, siteB } = await setupScenario();
    await reassign(missionId, siteB);
    expect(await pullSiteIds(tokenFor(agentId))).toContain(siteA); // échoue tant que le bug existe
  });

  // Garde-fou 3 : l'élargissement du EXISTS ne doit rien ouvrir à un autre agent.
  // agent2 a une mission sur B et aucun lien avec A : il reçoit B, jamais A.
  it("un autre agent sans lien avec le site A ne reçoit pas A", async () => {
    const { siteA, siteB } = await setupScenario();
    const agent2 = randomUUID();
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), tenantId, agent2, 'mission-agent2', siteB],
    );
    const ids = await pullSiteIds(tokenFor(agent2));
    expect(ids).toContain(siteB);
    expect(ids).not.toContain(siteA);
  });
});
