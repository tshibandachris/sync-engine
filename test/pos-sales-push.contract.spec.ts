import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { SyncController } from '../src/sync.controller.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { PosSalesPushService } from '../src/pos/pos-sales-push.service.js';
import { withTenant } from '../src/with-tenant.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { DeviceApprovalGuard } from '../src/device-approval.guard.js';
import { DeviceProofGuard } from '../src/auth/device-proof.guard.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { TEST_JWT_SECRET, TEST_TENANT_ID, createTestJwtService, signAgentToken } from './helpers/jwt.js';

describe('POS sales push contract', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  let token: string;
  let agentId: string;
  const tenantId = TEST_TENANT_ID;
  let staffId: string;
  let productId: string;
  let sessionId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const jwt = createTestJwtService();
    agentId = randomUUID();
    token = signAgentToken(agentId, jwt, tenantId);
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
    }).overrideGuard(DeviceApprovalGuard).useValue({ canActivate: () => true })
      .overrideGuard(DeviceProofGuard).useValue({ canActivate: () => true }).compile();
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
    const { quantity: _quantity, ...saleOverrides } = overrides;
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
      ...saleOverrides,
    };
  }

  async function pushChanges(changes: Record<string, unknown>, authToken = token, idempotencyKey?: string) {
    const call = request(app.getHttpServer()).post('/sync/push')
      .set('Authorization', 'Bearer ' + authToken);
    if (idempotencyKey) call.set('Idempotency-Key', idempotencyKey);
    return call.send({ changes });
  }

  async function push(sales: unknown[], authToken = token, idempotencyKey?: string) {
    return pushChanges({ sales }, authToken, idempotencyKey);
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

  it('replays POS sales even when the enclosing sync idempotency key was already recorded', async () => {
    const item = sale();
    const key = randomUUID();
    const first = await push([item], token, key);
    expect(first.body.results[0].status).toBe('applied');

    const replay = await push([item], token, key);
    expect(replay.status).toBe(201);
    expect(replay.body.results[0].status).toBe('idempotent');
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines WHERE sale_id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM stock_movements WHERE reference_id=$1', [item.id])).rows[0].count)).toBe(1);
  });

  it('returns conflict for the same sale UUID with changed total', async () => {
    const item = sale();
    expect((await push([item])).body.results[0].status).toBe('applied');
    const changed = { ...item, total: 2000, cash_amount: 2000, lines: item.lines.map(l => ({ ...l, quantity: 2, subtotal: 2000 })) };
    const res = await push([changed]);
    expect(res.body.results[0].status).toBe('conflict');
    expect(Number((await pg.pool.query('SELECT total FROM sales WHERE id=$1', [item.id])).rows[0].total)).toBe(1000);
  });

  it('returns conflict when the same UUID is retried with a different sale number', async () => {
    const item = sale();
    expect((await push([item])).body.results[0].status).toBe('applied');
    const changed = { ...item, sale_number: 'different-number' };
    const res = await push([changed]);
    expect(res.body.results[0].status).toBe('conflict');
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales')).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines WHERE sale_id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query("SELECT count(*) FROM stock_movements WHERE reference_id=$1 AND reference_type='sale'", [item.id])).rows[0].count)).toBe(1);
    expect((await pg.pool.query('SELECT sale_number FROM sales WHERE id=$1', [item.id])).rows[0].sale_number).toBe(item.sale_number);
  });

  it('rejects a void from another tenant and inserts no cross-tenant reference', async () => {
    const original = sale();
    expect((await push([original])).body.results[0].status).toBe('applied');

    const tenantB = randomUUID(), staffB = randomUUID(), productB = randomUUID(), sessionB = randomUUID();
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)', [tenantB, Date.now()]);
    const now = Date.now();
    await pg.pool.query("INSERT INTO staff (id,tenant_id,display_name,role,is_active,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,'Cashier B','cashier',true,$3,$3,0,0)", [staffB, tenantB, now]);
    await pg.pool.query("INSERT INTO products (id,tenant_id,name,price,stock_alert,is_active,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,'Coffee B',1000,5,true,$3,$3,0,0)", [productB, tenantB, now]);
    await pg.pool.query("INSERT INTO cash_sessions (id,tenant_id,staff_id,opened_at,opening_amount,status,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,$3,$4,10000,'open',$4,$4,0,0)", [sessionB, tenantB, staffB, now]);
    const tokenB = signAgentToken(randomUUID(), createTestJwtService(), tenantB);
    const voided = sale({ cash_session_id: sessionB, staff_id: staffB, total: -1000, cash_amount: -1000,
      quantity: -1, is_void: true, voided_sale_id: original.id, void_reason: 'Cross tenant attempt' });
    voided.lines[0].product_id = original.lines[0].product_id;
    voided.lines[0].quantity = -1;
    voided.lines[0].subtotal = -1000;
    voided.stock_movements[0].product_id = original.lines[0].product_id;
    voided.stock_movements[0].movement_type = 'void';
    voided.stock_movements[0].quantity_delta = 1;
    const res = await push([voided], tokenB);
    expect(res.body.results[0].status).toBe('invalid');
    expect(res.body.results[0].reason).toContain('original sale not found');
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE tenant_id=$1', [tenantB])).rows[0].count)).toBe(0);
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

  it('retries the same idempotency key after a simulated failure between key insert and POS write', async () => {
    const item = sale();
    const key = randomUUID();
    const prototype = PosSalesPushService.prototype as any;
    const originalPush = prototype.push;
    const originalPushInTransaction = prototype.pushInTransaction;
    const failAfterKeyInsert = async () => {
      throw new Error('simulated process failure before POS sale writes');
    };

    prototype.push = failAfterKeyInsert;
    prototype.pushInTransaction = failAfterKeyInsert;
    try {
      const failed = await push([item], token, key);
      expect(failed.status).toBe(500);
    } finally {
      prototype.push = originalPush;
      if (originalPushInTransaction) prototype.pushInTransaction = originalPushInTransaction;
      else delete prototype.pushInTransaction;
    }

    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sync_idempotency_keys WHERE agent_id=$1 AND idempotency_key=$2', [agentId, key])).rows[0].count)).toBe(0);

    const retried = await push([item], token, key);
    expect(retried.body.results[0].status).toBe('applied');
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines WHERE sale_id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query("SELECT count(*) FROM stock_movements WHERE reference_id=$1 AND reference_type='sale'", [item.id])).rows[0].count)).toBe(1);
  });

  it('serializes concurrent identical sale pushes as applied then idempotent without duplicate stock movements', async () => {
    const item = sale();
    const service: any = new PosSalesPushService(pg.appDb);
    const pushConcurrently = () => typeof service.pushInTransaction === 'function'
      ? withTenant(pg.appDb, tenantId, tx => service.pushInTransaction(tx, tenantId, [item]))
      : service.push(tenantId, [item]);
    const [left, right] = await Promise.all([pushConcurrently(), pushConcurrently()]);
    expect([left[0].status, right[0].status].sort()).toEqual(['applied', 'idempotent'].sort());
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines WHERE sale_id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query("SELECT count(*) FROM stock_movements WHERE reference_id=$1 AND reference_type='sale'", [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT COALESCE(SUM(quantity_delta),0) AS stock FROM stock_movements WHERE tenant_id=$1 AND product_id=$2', [tenantId, productId])).rows[0].stock)).toBe(-1);
  });

  it('does not partially write a sale or record its idempotency key when a later line fails', async () => {
    const item = sale();
    const key = randomUUID();
    const invalidProductId = randomUUID();
    item.total = 2000;
    item.cash_amount = 2000;
    item.lines.push({
      ...item.lines[0],
      id: randomUUID(),
      product_id: invalidProductId,
      product_name: 'Missing product',
      subtotal: 1000,
    });
    const response = await push([item], token, key);
    expect(response.body.results[0].status).toBe('invalid');
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines WHERE sale_id=$1', [item.id])).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query("SELECT count(*) FROM stock_movements WHERE reference_id=$1 AND reference_type='sale'", [item.id])).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sync_idempotency_keys WHERE agent_id=$1 AND idempotency_key=$2', [agentId, key])).rows[0].count)).toBe(0);
  });

  it('does not change stock or duplicate rows on a complete replay with the same idempotency key', async () => {
    const item = sale();
    const key = randomUUID();
    const first = await push([item], token, key);
    expect(first.body.results[0].status).toBe('applied');
    const before = Number((await pg.pool.query('SELECT COALESCE(SUM(quantity_delta),0) AS stock FROM stock_movements WHERE tenant_id=$1 AND product_id=$2', [tenantId, productId])).rows[0].stock);

    const replay = await push([item], token, key);
    expect(replay.status).toBe(201);
    expect(replay.body.results[0].status).toBe('idempotent');
    const after = Number((await pg.pool.query('SELECT COALESCE(SUM(quantity_delta),0) AS stock FROM stock_movements WHERE tenant_id=$1 AND product_id=$2', [tenantId, productId])).rows[0].stock);
    expect(after).toBe(before);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines WHERE sale_id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query("SELECT count(*) FROM stock_movements WHERE reference_id=$1 AND reference_type='sale'", [item.id])).rows[0].count)).toBe(1);
  });


  it('rolls back non-POS changes and the idempotency key when a keyed mixed push contains a sale conflict', async () => {
    const item = sale();
    expect((await push([item])).body.results[0].status).toBe('applied');
    const key = randomUUID();

    const response = await pushChanges({
      cash_sessions: [{ id: sessionId, notes: 'must roll back', lastKnownSyncSeq: 0 }],
      sales: [{ ...item, sale_number: 'different-number' }],
    }, token, key);

    expect(response.status).toBe(409);
    expect((await pg.pool.query('SELECT notes FROM cash_sessions WHERE id=$1', [sessionId])).rows[0].notes).toBeNull();
    expect(Number((await pg.pool.query('SELECT count(*) FROM sync_idempotency_keys WHERE agent_id=$1 AND idempotency_key=$2', [agentId, key])).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(1);
    expect((await pg.pool.query('SELECT sale_number FROM sales WHERE id=$1', [item.id])).rows[0].sale_number).toBe(item.sale_number);
  });

  it('rolls back earlier successful sales and the idempotency key when a later sale in the keyed batch is invalid', async () => {
    const good = sale();
    const bad = sale();
    bad.lines[0].product_id = randomUUID();
    bad.stock_movements[0].product_id = bad.lines[0].product_id;
    const key = randomUUID();

    const response = await push([good, bad], token, key);

    expect(response.status).toBe(400);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales')).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines')).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query('SELECT count(*) FROM stock_movements')).rows[0].count)).toBe(0);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sync_idempotency_keys WHERE agent_id=$1 AND idempotency_key=$2', [agentId, key])).rows[0].count)).toBe(0);
  });

  it('serializes concurrent identical sales through the production HTTP push path', async () => {
    const item = sale();
    const [left, right] = await Promise.all([push([item]), push([item])]);
    expect([left.status, right.status]).toEqual([201, 201]);
    expect([left.body.results[0].status, right.body.results[0].status].sort()).toEqual(['applied', 'idempotent'].sort());
    expect(Number((await pg.pool.query('SELECT count(*) FROM sales WHERE id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query('SELECT count(*) FROM sale_lines WHERE sale_id=$1', [item.id])).rows[0].count)).toBe(1);
    expect(Number((await pg.pool.query("SELECT count(*) FROM stock_movements WHERE reference_id=$1 AND reference_type='sale'", [item.id])).rows[0].count)).toBe(1);
  });

  it('uses READ COMMITTED for tenant transactions that rely on ON CONFLICT followed by reread', async () => {
    const isolation = await withTenant(pg.appDb, tenantId, async tx => {
      const result = await tx.execute(sql`SHOW transaction_isolation`);
      return (result.rows[0] as Record<string, unknown>).transaction_isolation;
    }, { write: true });
    expect(isolation).toBe('read committed');
  });

  it('ignores server-generated updated_at values when comparing a replay', async () => {
    const item = sale();
    item.updated_at = 1;
    item.lines[0].updated_at = 1;
    item.stock_movements[0].updated_at = 1;

    expect((await push([item])).body.results[0].status).toBe('applied');

    const storedSale = (await pg.pool.query('SELECT created_at, updated_at FROM sales WHERE id=$1', [item.id])).rows[0];
    const storedLine = (await pg.pool.query('SELECT created_at, updated_at FROM sale_lines WHERE id=$1', [item.lines[0].id])).rows[0];
    const storedMovement = (await pg.pool.query('SELECT created_at, updated_at FROM stock_movements WHERE id=$1', [item.stock_movements[0].id])).rows[0];

    expect(Number(storedSale.created_at)).toBe(item.created_at);
    expect(Number(storedLine.created_at)).toBe(item.lines[0].created_at);
    expect(Number(storedMovement.created_at)).toBe(item.stock_movements[0].created_at);
    expect(Number(storedSale.updated_at)).toBeGreaterThan(1);
    expect(Number(storedLine.updated_at)).toBeGreaterThan(1);
    expect(Number(storedMovement.updated_at)).toBeGreaterThan(1);

    const replayWithDifferentClientUpdatedAt = {
      ...item,
      updated_at: 2,
      lines: item.lines.map(line => ({ ...line, updated_at: 2 })),
      stock_movements: item.stock_movements.map(movement => ({ ...movement, updated_at: 2 })),
    };
    expect((await push([replayWithDifferentClientUpdatedAt])).body.results[0].status).toBe('idempotent');
  });

});
