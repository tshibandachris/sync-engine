-- POS migration smoke test: run after applying migrations/001..020 to an empty PostgreSQL database.
-- Verifies shared sync trigger fields and tenant RLS using the restricted application role.

BEGIN;

INSERT INTO tenants (id, first_seen_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE sync_app;
SELECT set_config('app.current_tenant_id', '11111111-1111-4111-8111-111111111111', true);

INSERT INTO products (
  id, tenant_id, name, price, created_at, updated_at, sync_seq, first_sync_seq
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'POS smoke product', 500, NULL, 0, 0, 0
);

DO $$
DECLARE
  first_seq bigint;
  current_seq bigint;
  created_ms bigint;
  updated_ms bigint;
BEGIN
  SELECT first_sync_seq, sync_seq, created_at, updated_at
    INTO first_seq, current_seq, created_ms, updated_ms
  FROM products WHERE id = '22222222-2222-4222-8222-222222222222';

  IF first_seq IS NULL OR current_seq IS NULL OR first_seq <> current_seq THEN
    RAISE EXCEPTION 'products INSERT trigger did not set sync_seq/first_sync_seq';
  END IF;
  IF created_ms <= 0 OR updated_ms <= 0 THEN
    RAISE EXCEPTION 'products INSERT trigger did not set millisecond timestamps';
  END IF;
END $$;

UPDATE products
SET name = 'POS smoke product updated'
WHERE id = '22222222-2222-4222-8222-222222222222';

DO $$
DECLARE
  first_seq bigint;
  current_seq bigint;
BEGIN
  SELECT first_sync_seq, sync_seq
    INTO first_seq, current_seq
  FROM products WHERE id = '22222222-2222-4222-8222-222222222222';

  IF first_seq IS NULL OR current_seq IS NULL OR current_seq <= first_seq THEN
    RAISE EXCEPTION 'products UPDATE trigger did not advance sync_seq while preserving first_sync_seq';
  END IF;
END $$;

-- A row for another tenant must be rejected by WITH CHECK.
DO $$
BEGIN
  BEGIN
    INSERT INTO products (
      id, tenant_id, name, price, created_at, updated_at, sync_seq, first_sync_seq
    ) VALUES (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Cross-tenant row', 100, NULL, 0, 0, 0
    );
    RAISE EXCEPTION 'RLS accepted a cross-tenant product insert';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END $$;

INSERT INTO staff (
  id, tenant_id, display_name, role, created_at, updated_at, sync_seq, first_sync_seq
) VALUES (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'POS Smoke Cashier', 'cashier', NULL, 0, 0, 0
);

INSERT INTO cash_sessions (
  id, tenant_id, staff_id, opened_at, opening_amount, created_at, updated_at, sync_seq, first_sync_seq
) VALUES (
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  1000, 1000, NULL, 0, 0, 0
);

DO $$
BEGIN
  IF (SELECT sync_seq FROM staff WHERE id = '33333333-3333-4333-8333-333333333333') <= 0 THEN
    RAISE EXCEPTION 'staff INSERT trigger did not set sync_seq';
  END IF;
  IF (SELECT sync_seq FROM cash_sessions WHERE id = '44444444-4444-4444-8444-444444444444') <= 0 THEN
    RAISE EXCEPTION 'cash_sessions INSERT trigger did not set sync_seq';
  END IF;
END $$;

ROLLBACK;
