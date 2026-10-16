import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('POS multi-device synchronization contract', () => {
  let pg: TestPostgres;
  let push: SyncPushService;
  let pull: SyncPullService;
  const tenantId = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  let staffId: string;
  let productId: string;
  let sessionId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    push = new SyncPushService(pg.appDb);
    pull = new SyncPullService(pg.appDb);
  }, 120_000);

  afterAll(async () => { await pg.stop(); });

  beforeEach(async () => {
    await pg.pool.query('TRUNCATE stock_movements, sale_lines, sales, cash_sessions, staff, products, check_ins, missions, sites, sync_idempotency_keys, sync_conflicts RESTART IDENTITY CASCADE');
    await pg.pool.query('ALTER SEQUENCE global_sync_seq RESTART WITH 1');
    await pg.pool.query('INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [tenantId, Date.now()]);
    const now = Date.now();
    staffId = randomUUID();
    productId = randomUUID();
    sessionId = randomUUID();

    await pg.pool.query(
      "INSERT INTO staff (id,tenant_id,display_name,role,is_active,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,'Cashier','cashier',true,$3,$3,0,0)",
      [staffId, tenantId, now],
    );
    await pg.pool.query(
      "INSERT INTO products (id,tenant_id,name,price,cost,stock_alert,is_active,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,'Coffee',1000,400,5,true,$3,$3,0,0)",
      [productId, tenantId, now],
    );
    await pg.pool.query(
      "INSERT INTO cash_sessions (id,tenant_id,staff_id,opened_at,opening_amount,status,created_at,updated_at,sync_seq,first_sync_seq) VALUES ($1,$2,$3,$4,10000,'open',$4,$4,0,0)",
      [sessionId, tenantId, staffId, now],
    );
  });

  function sale(overrides: Record<string, any> = {}) {
    const id = randomUUID();
    const lineId = randomUUID();
    const movementId = randomUUID();
    const now = Date.now();
    const quantity = overrides.quantity ?? 1;
    const total = overrides.total ?? quantity * 1000;
    const { quantity: _quantity, ...saleOverrides } = overrides;
    return {
      id,
      cash_session_id: sessionId,
      staff_id: staffId,
      sale_number: 'S-' + id.slice(0, 8),
      total,
      payment_method: 'cash',
      cash_amount: total,
      mobile_amount: 0,
      is_void: false,
      voided_sale_id: null,
      void_reason: null,
      created_at: now,
      updated_at: now,
      lines: [{
        id: lineId, product_id: productId, product_name: 'Coffee', product_sku: null,
        quantity, unit_price: 1000, subtotal: quantity * 1000, created_at: now, updated_at: now,
      }],
      stock_movements: [{
        id: movementId, product_id: productId, movement_type: 'sale', quantity_delta: -quantity,
        reference_id: id, reference_type: 'sale', unit_cost: 400, notes: null,
        created_at: now, updated_at: now, created_by: staffId,
      }],
      ...saleOverrides,
    };
  }

  async function pushSales(items: unknown[], agentId: string) {
    return push.pushChanges(agentId, { changes: { sales: items } }, undefined, tenantId);
  }

  it('keeps both simultaneous offline sales and both stock movements', async () => {
    // A and B started from the same tenant snapshot and sell the same product
    // concurrently. The server must append both sales, not overwrite one.
    const saleA = sale();
    const saleB = sale();
    saleB.sale_number = 'S-CONCURRENT-B';

    const [resultA, resultB] = await Promise.all([
      pushSales([saleA], agentA),
      pushSales([saleB], agentB),
    ]);

    expect(resultA.results?.map((r) => r.status)).toEqual(['applied']);
    expect(resultB.results?.map((r) => r.status)).toEqual(['applied']);

    const rows = await pg.pool.query(
      'SELECT count(*)::int AS sales_count FROM sales WHERE tenant_id = $1',
      [tenantId],
    );
    const movements = await pg.pool.query(
      'SELECT count(*)::int AS movement_count, COALESCE(sum(quantity_delta), 0)::int AS stock_delta FROM stock_movements WHERE tenant_id = $1 AND product_id = $2',
      [tenantId, productId],
    );

    expect(rows.rows[0].sales_count).toBe(2);
    expect(movements.rows[0].movement_count).toBe(2);
    expect(movements.rows[0].stock_delta).toBe(-2);
  }, 120_000);

  it('makes pushed sales, lines and stock movements visible to the other device through pull', async () => {
    const item = sale();
    const pushed = await pushSales([item], agentA);
    expect(pushed.results?.[0]?.status).toBe('applied');

    const response = await pull.pullChanges({
      agentId: agentB,
      tenantId,
      lastPulledAt: 0,
    });

    // This assertion intentionally exercises the public pull contract rather
    // than reading the database directly. It must fail if the pull projection
    // omits the POS ledger entities.
    expect(response.changes).toHaveProperty('sales');
    expect(response.changes).toHaveProperty('sale_lines');
    expect(response.changes).toHaveProperty('stock_movements');

    const pulled = response.changes as any;
    expect(pulled.sales.created.map((row: any) => row.id)).toContain(item.id);
    expect(pulled.sale_lines.created.map((row: any) => row.sale_id)).toContain(item.id);
    expect(pulled.stock_movements.created.map((row: any) => row.reference_id)).toContain(item.id);
  }, 120_000);

  it('pulls a closed session reconciliation and both the original sale and its void', async () => {
    const original = sale();
    expect((await pushSales([original], agentA)).results?.[0]?.status).toBe('applied');

    await pg.pool.query(
      "UPDATE cash_sessions SET status='closed', closed_at=$2, closing_amount=10000, expected_amount=11000, difference=-1000 WHERE id=$1",
      [sessionId, Date.now()],
    );

    const voided = sale({
      total: -1000,
      cash_amount: -1000,
      is_void: true,
      voided_sale_id: original.id,
      void_reason: 'Device correction',
      quantity: -1,
    });
    voided.sale_number = 'VOID-' + original.id.slice(0, 8);
    voided.lines[0].quantity = -1;
    voided.lines[0].subtotal = -1000;
    voided.stock_movements[0].movement_type = 'void';
    voided.stock_movements[0].quantity_delta = 1;

    expect((await pushSales([voided], agentA)).results?.[0]?.status).toBe('applied');

    const response = await pull.pullChanges({
      agentId: agentB,
      tenantId,
      lastPulledAt: 0,
    });

    expect(response.changes).toHaveProperty('sales');
    expect(response.changes).toHaveProperty('cash_sessions');
    const pulled = response.changes as any;
    const saleIds = pulled.sales.created.map((row: any) => row.id);
    expect(saleIds).toContain(original.id);
    expect(saleIds).toContain(voided.id);

    const session = [
      ...pulled.cash_sessions.created,
      ...pulled.cash_sessions.updated,
    ].find((row: any) => row.id === sessionId);
    expect(session?.status).toBe('closed');
    expect(session?.reconciledAt ?? session?.reconciled_at).toBeTruthy();
  }, 120_000);
});
