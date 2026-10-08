import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';
import type {
  AttachmentStorage,
  PresignedPut,
  PresignedGet,
  HeadResult,
} from '../src/attachment-storage.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

/**
 * In-memory storage. Holds a Map of key -> true. delete() removes from
 * the map so a subsequent listByPrefix() does not return it.
 */
class MemStorage implements AttachmentStorage {
  readonly objects = new Map<string, number>();
  readonly deletes: string[] = [];
  failNextDelete = false;

  async presignPut(): Promise<PresignedPut> { return { url: 'x', expiresIn: 0 }; }
  async presignGet(): Promise<PresignedGet> { return { url: 'x', expiresIn: 0 }; }
  async head(): Promise<HeadResult> { return { exists: false }; }

  async delete(objectKey: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('simulated S3 failure');
    }
    this.deletes.push(objectKey);
    this.objects.delete(objectKey);
  }

  async listByPrefix(prefix: string): Promise<{ key: string; sizeBytes: number }[]> {
    return Array.from(this.objects.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, sizeBytes]) => ({ key, sizeBytes }));
  }
}

describe('scanTenantOrphans', () => {
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const siteId = randomUUID();
  const missionId = randomUUID();
  const checkInId = randomUUID();

  let svc: SyncMaintenanceService;
  let storage: MemStorage;

  beforeAll(() => {
    svc = new SyncMaintenanceService(pg.appDb);
    storage = new MemStorage();
  });

  beforeEach(async () => {
    // Nettoyage par le superuser (RLS bypass).
    await pg.pool.query('DELETE FROM attachments WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM check_ins WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM missions WHERE tenant_id = $1', [tenantId]);
    await pg.pool.query('DELETE FROM sites WHERE tenant_id = $1', [tenantId]);

    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, 0, 0)',
      [siteId, tenantId, 'site-scan'],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionId, tenantId, agentId, 'mission-scan', siteId],
    );
    await pg.pool.query(
      `INSERT INTO check_ins
         (id, tenant_id, mission_id, agent_id, check_in_time, check_out_time,
          check_in_lat, check_in_lng, check_in_method, created_at, updated_at,
          deleted_at, sync_seq)
       VALUES ($1, $2, $3, $4, $5, NULL, 0, 0, 'GPS', $5, $5, NULL, 0)`,
      [checkInId, tenantId, missionId, agentId, Date.now()],
    );

    storage.objects.clear();
    storage.deletes.length = 0;
    storage.failNextDelete = false;
  });

  function key(suffix: string): string {
    return 'tenants/' + tenantId + '/checkins/' + checkInId + '/' + suffix;
  }

  async function seedAttachmentRow(objectKey: string, status: 'pending' | 'uploaded' = 'uploaded'): Promise<void> {
    await pg.pool.query(
      `INSERT INTO attachments
         (id, tenant_id, check_in_id, agent_id, object_key, content_type,
          size_bytes, checksum_sha256, status, created_at, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, 'image/jpeg', 1024, $6, $7, $8, $9)`,
      [
        randomUUID(), tenantId, checkInId, agentId, objectKey,
        'a'.repeat(64), status, Date.now(),
        status === 'uploaded' ? Date.now() : null,
      ],
    );
  }

  it('retourne un tableau vide si aucun objet ne traine', async () => {
    const k = key('known.jpg');
    await seedAttachmentRow(k);
    storage.objects.set(k, 1024);

    const r = await svc.scanTenantOrphans(storage, tenantId);
    expect(r.scanned).toBe(1);
    expect(r.orphans).toEqual([]);
    expect(r.deleted).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(storage.objects.has(k)).toBe(true);
  });

  it('dry-run detecte les orphelins sans rien supprimer', async () => {
    const known = key('known.jpg');
    const orphan = key('orphan.jpg');
    await seedAttachmentRow(known);
    storage.objects.set(known, 1024);
    storage.objects.set(orphan, 2048);

    const r = await svc.scanTenantOrphans(storage, tenantId);
    expect(r.scanned).toBe(2);
    expect(r.orphans).toEqual([orphan]);
    expect(r.deleted).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(storage.objects.has(orphan)).toBe(true); // pas supprime
  });

  it('dryRun: false supprime les orphelins', async () => {
    const known = key('known.jpg');
    const orphan = key('orphan.jpg');
    await seedAttachmentRow(known);
    storage.objects.set(known, 1024);
    storage.objects.set(orphan, 2048);

    const r = await svc.scanTenantOrphans(storage, tenantId, { dryRun: false });
    expect(r.dryRun).toBe(false);
    expect(r.deleted).toBe(1);
    expect(r.failed).toBe(0);
    expect(storage.objects.has(known)).toBe(true);
    expect(storage.objects.has(orphan)).toBe(false);
  });

  it('abandonne si plus de 50% des objets sont orphelins', async () => {
    // 1 connu, 2 orphelins : 2/3 > 0.5
    const known = key('known.jpg');
    await seedAttachmentRow(known);
    storage.objects.set(known, 1024);
    storage.objects.set(key('o1.jpg'), 1024);
    storage.objects.set(key('o2.jpg'), 1024);

    const r = await svc.scanTenantOrphans(storage, tenantId, { dryRun: false });
    expect(r.aborted).toBe(true);
    expect(r.deleted).toBe(0);
    expect(r.orphans).toHaveLength(2);
    expect(r.abortReason).toMatch(/0\.6[0-9]/);
    expect(storage.objects.size).toBe(3); // rien supprime
  });

  it('allowHighOrphanRatio permet de forcer la suppression', async () => {
    await seedAttachmentRow(key('known.jpg'));
    storage.objects.set(key('known.jpg'), 1024);
    storage.objects.set(key('o1.jpg'), 1024);
    storage.objects.set(key('o2.jpg'), 1024);

    const r = await svc.scanTenantOrphans(storage, tenantId, {
      dryRun: false,
      allowHighOrphanRatio: true,
    });
    expect(r.aborted).toBe(false);
    expect(r.deleted).toBe(2);
    expect(storage.objects.size).toBe(1);
  });

  it('compte les echecs de suppression sans interrompre le scan', async () => {
    const o1 = key('o1.jpg');
    const o2 = key('o2.jpg');
    await seedAttachmentRow(key('known.jpg'));
    storage.objects.set(key('known.jpg'), 1024);
    storage.objects.set(o1, 1024);
    storage.objects.set(o2, 1024);

    storage.failNextDelete = true; // echec sur le premier DELETE
    const r = await svc.scanTenantOrphans(storage, tenantId, {
      dryRun: false,
      allowHighOrphanRatio: true,
    });
    expect(r.deleted).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.orphans.sort()).toEqual([o1, o2].sort());
  });

  it('ne touche pas aux objets des autres tenants', async () => {
    const otherTenant = randomUUID();
    const mine = key('mine.jpg');
    await seedAttachmentRow(mine);
    storage.objects.set(mine, 1024);
    storage.objects.set('tenants/' + otherTenant + '/checkins/x/y.jpg', 1024);

    const r = await svc.scanTenantOrphans(storage, tenantId, { dryRun: false });
    expect(r.scanned).toBe(1);
    expect(r.deleted).toBe(0);
    // L'objet de l'autre tenant n'est pas listé, donc pas affecté.
    expect(storage.objects.has('tenants/' + otherTenant + '/checkins/x/y.jpg')).toBe(true);
  });

  it('dry-run par defaut : le parametre est optionnel et vaut true', async () => {
    const orphan = key('orphan.jpg');
    storage.objects.set(orphan, 1024);

    const r = await svc.scanTenantOrphans(storage, tenantId);
    expect(r.dryRun).toBe(true);
    expect(r.deleted).toBe(0);
    expect(storage.objects.has(orphan)).toBe(true);
  });
});
