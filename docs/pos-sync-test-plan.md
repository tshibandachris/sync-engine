# POS synchronization test plan

## Purpose

Prove that the POS schema and sync engine preserve offline-created records across devices without silently losing or duplicating sales, sale lines, stock movements, or inventory changes.

## Gate 0 — Fresh database migrations

- [ ] Apply migrations 001 through the latest POS migration to an empty PostgreSQL database in lexical order.
- [ ] Verify the migration process stops immediately on the first SQL error.
- [ ] Verify products, staff, and cash_sessions have tenant RLS enabled and forced.
- [ ] Verify inserts allocate a new global_sync_seq value and set sync_seq and first_sync_seq.
- [ ] Verify updates advance sync_seq, preserve first_sync_seq, and update updated_at in milliseconds.
- [ ] Verify sync_app cannot read or write another tenant's rows.
- [ ] Verify cross-tenant foreign-key relationships are rejected.

## Gate 1 — Database invariants

- [ ] Reject a second open cash session for the same staff member in the same tenant.
- [ ] Reject inconsistent open/closed cash-session states.
- [ ] Reject UPDATE and DELETE on append-only ledger tables.
- [ ] Reject a second void sale for the same original sale.
- [ ] Reject a sale that references itself as its void.
- [ ] Reject sale lines whose tenant differs from the referenced sale or product.
- [ ] Reject stock movements whose tenant differs from the referenced product or staff member.
- [ ] Reject duplicate products within one inventory count.
- [ ] Ensure completing an inventory count creates adjustment movements exactly once.

## Staff PIN boundary (required for staff push)

- Staff created offline through sync starts without a PIN; it cannot authenticate until a PIN is configured separately.
- The sync schema rejects every PIN-related input key with: `PIN cannot be set through sync. Use POST /staff/:id/pin`.
- Staff push INSERT/UPDATE statements must never write `pin_hash`, `pin_algo`, or `auth_subject`.
- A future authenticated `POST /staff/:id/pin` route must accept plaintext only over HTTPS, hash it server-side, and write credential columns outside sync.
- When the UI needs PIN setup state, staff pull may expose only `has_pin: boolean`; never expose the hash, algorithm, or auth subject. This is follow-up work, not part of the first push iteration.
- Staff soft-delete/deactivation must return HTTP 409 if it would leave the tenant without an active owner.

## Gate 2 — Push/pull contract

- [ ] Validate all POS entity names and payload schemas; reject unknown entities and malformed fields.
- [ ] Push creates for products, staff, cash_sessions, sales, sale_lines, stock_movements, inventory_counts, and inventory_count_lines.
- [ ] Pull returns each entity with stable identifiers, sync_seq, first_sync_seq, timestamps, and deletion semantics.
- [ ] A newly created record is classified as created when first_sync_seq > client cursor; later changes are classified as updated.
- [ ] A cursor advances only to the last contiguous/consumed event sequence; concurrent tenant writes must not create invisible sequence gaps.
- [ ] Idempotent retries do not create duplicate sales, sale lines, or stock movements.
- [ ] Tenant isolation is enforced on every push, pull, conflict, and retry path.
- [ ] Conflicts are explicit; no POS payload is silently ignored.

## Gate 3 — Two-device offline scenario

1. Start with a clean tenant and two clients, A (cashier) and B (manager/tablet).
2. Pull the initial dataset to both clients and record their cursors.
3. Disconnect A from the network.
4. On A, create a product, open a cash session, record a sale with multiple lines, and record corresponding stock movements.
5. Reconnect A and push the pending changes; record the server response and cursor.
6. Pull on B from its previous cursor.
7. Assert B receives the product, session, sale, all sale lines, and stock movements exactly once.
8. Assert the stock balance on A, server, and B agrees with the sum of movement deltas.
9. Replay A's identical push with the same idempotency key; assert no duplicate business records or movements.
10. Void the sale and verify the mirror sale, negative quantities/totals, and positive stock reversals propagate to B exactly once.
11. Repeat with two concurrent pushes and a deliberately stale cursor.
12. Assert all tenant boundaries remain intact.

## Release criterion

Do not declare POS synchronization production-ready until Gates 0–3 pass in CI and the two-device scenario passes against the real NestJS push/pull services. Schema migration success alone is not proof of end-to-end synchronization.
