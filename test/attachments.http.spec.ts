import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import * as schema from '../src/schema.js';
import { AttachmentService } from '../src/sync-attachment.service.js';
import { AttachmentController } from '../src/sync-attachment.controller.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import type { AttachmentStorage, PresignedPut, PresignedGet, HeadResult } from '../src/attachment-storage.js';
import {
  TEST_JWT_SECRET,
  TEST_TENANT_ID,
  createTestJwtService,
  signAgentToken,
} from './helpers/jwt.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class FakeStorage implements AttachmentStorage {
  public putCalls: { key: string; contentType: string }[] = [];
  public getCalls: { key: string }[] = [];
  public objects = new Set<string>();

  async presignPut(objectKey: string, contentType: string): Promise<PresignedPut> {
    this.putCalls.push({ key: objectKey, contentType });
    return { url: 'https://fake-s3.local/put/' + objectKey, expiresIn: 900 };
  }

  async presignGet(objectKey: string): Promise<PresignedGet> {
    this.getCalls.push({ key: objectKey });
    return { url: 'https://fake-s3.local/get/' + objectKey, expiresIn: 3600 };
  }

  async head(objectKey: string): Promise<HeadResult> {
    if (this.objects.has(objectKey)) {
      return { exists: true, sizeBytes: 1024, contentType: 'image/jpeg' };
    }
    return { exists: false };
  }
}

describe('Attachments / HTTP', () => {
  let pg: TestPostgres;
  let db: NodePgDatabase<typeof schema>;
  let app: INestApplication;
  let jwt: JwtService;
  let storage: FakeStorage;
  let tokenA: string;
  let tokenB: string;

  const agentA = randomUUID();
  const agentB = randomUUID();
  const tenantA = TEST_TENANT_ID;
  const tenantB = randomUUID();
  const siteA = randomUUID();
  const missionA = randomUUID();
  let checkInA: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    db = drizzle(pg.pool, { schema });
    jwt = createTestJwtService();
    storage = new FakeStorage();
    tokenA = signAgentToken(agentA, jwt, tenantA);
    tokenB = signAgentToken(agentB, jwt, tenantB);

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '30d' },
        }),
      ],
      controllers: [AttachmentController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: AttachmentService, useFactory: (d: any) => new AttachmentService(d, storage), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
  });

  beforeEach(async () => {
    storage.putCalls = [];
    storage.getCalls = [];
    storage.objects.clear();

    await pg.pool.query('TRUNCATE check_ins, missions, sites, sync_idempotency_keys, sync_conflicts, attachments RESTART IDENTITY CASCADE');
    await pg.pool.query('ALTER SEQUENCE global_sync_seq RESTART WITH 1');

    await pg.pool.query(
      'INSERT INTO sites (id, tenant_id, name, latitude, longitude) VALUES ($1, $2, $3, $4, $5)',
      [siteA, tenantA, 'Site A', 48.85, 2.35],
    );
    await pg.pool.query(
      'INSERT INTO missions (id, tenant_id, agent_id, title, site_id) VALUES ($1, $2, $3, $4, $5)',
      [missionA, tenantA, agentA, 'Mission A', siteA],
    );

    checkInA = randomUUID();
    await pg.pool.query(
      `INSERT INTO check_ins (id, tenant_id, mission_id, agent_id, check_in_time, check_out_time, check_in_lat, check_in_lng, check_in_method, created_at, updated_at, deleted_at, sync_seq)
       VALUES ($1, $2, $3, $4, $5, NULL, 48.85, 2.35, 'GPS', $6, $6, NULL, nextval('global_sync_seq'))`,
      [checkInA, tenantA, missionA, agentA, Date.now(), Date.now()],
    );
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      check_in_id: checkInA,
      content_type: 'image/jpeg',
      size_bytes: 1024 * 1024,
      checksum_sha256: 'a'.repeat(64),
      ...overrides,
    };
  }

  it('rejects request-upload without auth', async () => {
    const res = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .send(validBody());
    expect(res.status).toBe(401);
  });

  it('request-upload creates a pending attachment and returns a presigned URL', async () => {
    const res = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.attachment_id).toMatch(UUID_RE);
    expect(res.body.object_key).toMatch(/^tenants\//);
    expect(res.body.upload_url).toMatch(/^https:\/\/fake-s3\.local\/put\//);
    expect(res.body.expires_in).toBe(900);
    expect(storage.putCalls).toHaveLength(1);

    const rows = await pg.pool.query('SELECT status FROM attachments WHERE id = $1', [res.body.attachment_id]);
    expect(rows.rows[0].status).toBe('pending');
  });

  it('request-upload rejects invalid content_type', async () => {
    const res = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody({ content_type: 'application/pdf' }));
    expect(res.status).toBe(400);
  });

  it('request-upload rejects size over 10 Mo', async () => {
    const res = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody({ size_bytes: 11 * 1024 * 1024 }));
    expect(res.status).toBe(400);
  });

  it('request-upload rejects invalid checksum', async () => {
    const res = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody({ checksum_sha256: 'not-hex' }));
    expect(res.status).toBe(400);
  });

  it('request-upload rejects a check-in from another tenant', async () => {
    const res = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenB)
      .send(validBody());
    expect(res.status).toBe(403);
  });

  it('request-upload rejects when 5 attachments already exist', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app.getHttpServer())
        .post('/attachments/request-upload')
        .set('Authorization', 'Bearer ' + tokenA)
        .send(validBody());
      expect(r.status).toBe(201);
    }
    const res = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody());
    expect(res.status).toBe(409);
  });

  it('confirm-upload marks as uploaded when object exists', async () => {
    const upload = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody());

    storage.objects.add(upload.body.object_key);

    const res = await request(app.getHttpServer())
      .post('/attachments/' + upload.body.attachment_id + '/confirm')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('uploaded');
    expect(typeof res.body.uploaded_at).toBe('number');
  });

  it('confirm-upload rejects when the object is absent', async () => {
    const upload = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody());

    const res = await request(app.getHttpServer())
      .post('/attachments/' + upload.body.attachment_id + '/confirm')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});

    expect(res.status).toBe(409);
  });

  it('list returns only uploaded attachments with download URLs', async () => {
    const upload1 = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody());
    const upload2 = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody());

    storage.objects.add(upload1.body.object_key);
    await request(app.getHttpServer())
      .post('/attachments/' + upload1.body.attachment_id + '/confirm')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});

    const res = await request(app.getHttpServer())
      .get('/attachments?check_in_id=' + checkInA)
      .set('Authorization', 'Bearer ' + tokenA);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(upload1.body.attachment_id);
    expect(res.body[0].download_url).toMatch(/^https:\/\/fake-s3\.local\/get\//);
    expect(res.body[0].expires_in).toBe(3600);
  });

  it('list does not leak attachments from another tenant', async () => {
    const upload = await request(app.getHttpServer())
      .post('/attachments/request-upload')
      .set('Authorization', 'Bearer ' + tokenA)
      .send(validBody());
    storage.objects.add(upload.body.object_key);
    await request(app.getHttpServer())
      .post('/attachments/' + upload.body.attachment_id + '/confirm')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});

    const res = await request(app.getHttpServer())
      .get('/attachments?check_in_id=' + checkInA)
      .set('Authorization', 'Bearer ' + tokenB);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
