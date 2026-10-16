import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncController } from '../src/sync.controller.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET, TEST_TENANT_ID, createTestJwtService, signAgentToken } from './helpers/jwt.js';

describe('POS sales push contract', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let token: string;
  const tenantId = TEST_TENANT_ID;
  let staffId: string;
  let productId: string;
  let sessionId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const jwt = createTestJwtService();
    token = signAgentToken(randomUUID(), jwt, tenantId);
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '30d' } })],
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    await app.init();
  });

  afterAll(async () => { await app.close(); await pg.stop(); });

  beforeEach(async () => {
    await pg.pool.query('TRUNCATE stock_movements, sale_lines, sales, cash_sessions, staff, products, check_ins, missions, sites, sync_idempotency_keys, sync_conflicts RESTART IDENTITY CASCADE');
    await pg.pool.query("ALTER SEQUENCE global_sync_seq RESTART WITH 1");
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [tenantId, Date.now()]);
    const now = Date.now();
    staffId = randomUUID();
    productId = randomUUID();
    sessionId = randomUUID();
    await pg.pool.query("INSERT INTO staff (id,tenant_id,display_name,role,is_active,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,'Cashier','cashier',true,$3,$3,0,0)", [staffId, tenantId, now]);
    await pg.pool.query("INSERT INTO products (id,tenant_id,name,price,stock_alert,is_active,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,'Coffee',1000,5,true,$3,$3,0,0)", [productId, tenantId, now]);
    await pg.pool.query("INSERT INTO cash_sessions (id,tenant_id,staff_id,opened_at,opening_amount,status,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,$3,$4,10000,'open',$4,$4,0,0)", [sessionId, tenantId, staffId, now]);
  });

  function sale(overrides: Record<string, any> = {}) {
    const id = randomUUID(), lineId = randomUUID(), movementId = randomUUID(), now = Date.now();
    const total = overrides.total ?? 1000;
    const quantity = overrides.quantity ?? 1;
    const isVoid = overrides.is_void ?? false;
    return {
      id, cash_session_id: sessionId, staff_id: staffId, sale_number: 'S-' + id.slice(0, 8),
      total, payment_method: 'cash', cash_amount: total, mobile_amount: 0,
      is_void: isVoid, voided_sale_id: null, void_reason: null, created_at: now, updated_at: now,
      lines: [{ id: lineId, product_id: productId, product_name: 'Coffee', product_sku: null,
        quantity, unit_price: 1000, subtotal: quantity * 1000, created_at: now, updated_at: now }],
      stock_movements: [{ id: movementId, product_id: productId,
        movement_type: isVoid ? 'void' : 'sale', quantity_delta: isVoid ? 1 : -1,
        reference_id: id, reference_type: 'sale', unit_cost: null, notes: null,
        created_at: now, updated_at: now, created_by: staffId }],
      ...overrides,
    };
  }

  async function push(sales: unknown[]) {
    return request(app.getHttpServer()).post('/sync/push')
      .set('Authorization', 'Bearer ' + token).send({ changes: { sales } });
  }

  it('commits valid sale while rolling back invalid sale independently', async () => {
    const good = sale();
    const bad = sale();
    bad.lines[0].product_id = randomUUID();
    bad.stock_movements[0].product_id = bad.lines[0].product_id;
    const res = await push([good, bad]);
    expect(res.status).toBe(201);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'invalid']);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales')).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines')).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM stock_movements')).rows[0].count)).toBe(1);
  });

  it('returns idempotent for a full identical retry without duplicate rows', async () => {
    const item = sale();
    expect((await push([item])).body.results[0].status).toBe('applied');
    expect((await push([item])).body.results[0].status).toBe('idempotent');
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales')).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines')).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM stock_movements')).rows[0].count)).toBe(1);
  });

  it('returns conflict for the same sale UUID with changed total', async () => {
    const item = sale();
    expect((await push([item])).body.results[0].status).toBe('applied');
    const changed = { ...item, total: 2000, cash_amount: 2000 };
    const res = await push([changed]);
    expect(res.body.results[0].status).toBe('conflict');
    expect(Number((await pg.pool.query('SELECT total FROM sales WHERE id=$1', [item.id])).rows[0].total)).toBe(1000);
  });

  it('validates exact void mirror and rejects a second void', async () => {
    const original = sale();
    expect((await push([original])).body.results[0].status).toBe('applied');
    const voided = sale({ total: -1000, cash_amount: -1000, quantity: -1, is_void: true,
      voided_sale_id: original.id, void_reason: 'Correction' });
    voided.lines[0].subtotal = -1000;
    voided.lines[0].quantity = -1;
    voided.stock_movements[0].movement_type = 'void';
    voided.stock_movements[0].quantity_delta = 1;
    const first = await push([voided]);
    expect(first.body.results[0].status).toBe('applied');
    const second = await push([{ ...voided, id: randomUUID(), sale_number: 'second-void' }]);
    expect(second.body.results[0].status).toBe('conflict');
    const bad = sale({ total: -800, cash_amount: -800, quantity: -1, is_void: true,
      voided_sale_id: original.id, void_reason: 'Incorrect amount' });
    bad.lines[0].quantity = -1; bad.lines[0].unit_price = 800; bad.lines[0].subtotal = -800;
    bad.stock_movements[0].movement_type = 'void'; bad.stock_movements[0].quantity_delta = 1;
    expect((await push([bad])).body.results[0].status).toBe('invalid');
    expect((await push([bad])).body.results[0].reason).toContain('void amounts do not mirror original sale');
  });

  it('reconciles a closed session once from signed sales and preserves historical close fields', async () => {
    await pg.pool.query("UPDATE cash_sessions SET status='closed',closed_at=opened_at+1,closing_amount=10000,expected_amount=10000,difference=0 WHERE id=$1", [sessionId]);
    const historical = (await pg.pool.query('SELECT closing_amount,expected_amount,difference FROM cash_sessions WHERE id=$1', [sessionId])).rows[0];
    const batch = [sale(), sale(), sale()];
    batch.forEach((s, i) => { s.sale_number = 'batch-' + i; });
    const res = await push(batch);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied']);
    const after = (await pg.pool.query('SELECT closing_amount,expected_amount,difference,reconciled_expected_amount,reconciled_difference,reconciled_at FROM cash_sessions WHERE id=$1', [sessionId])).rows[0];
    expect(Number(after.reconciled_expected_amount)).toBe(13000);
    expect(Number(after.reconciled_difference)).toBe(-3000);
    expect(after.reconciled_at).toBeTruthy();
    expect(after.closing_amount).toBe(historical.closing_amount);
    expect(after.expected_amount).toBe(historical.expected_amount);
    expect(after.difference).toBe(historical.difference);
  });

  it('returns invalid with a clear reason when cash session is missing', async () => {
    const item = sale({ cash_session_id: randomUUID() });
    const res = await push([item]);
    expect(res.body.results[0].status).toBe('invalid');
    expect(res.body.results[0].reason).toContain('cash session not found');
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales')).rows[0].count)).toBe(0);
  });
});
