import {
  bigint,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  varchar,
  integer,
  boolean,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  name: text('name').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncSeq: bigint('sync_seq', { mode: 'number' }),
  firstSyncSeq: bigint('first_sync_seq', { mode: 'number' }),
});

export const missions = pgTable('missions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  agentId: uuid('agent_id').notNull(),
  siteId: uuid('site_id'),
  title: text('title').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncSeq: bigint('sync_seq', { mode: 'number' }),
  firstSyncSeq: bigint('first_sync_seq', { mode: 'number' }),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  sku: varchar('sku', { length: 64 }),
  barcode: varchar('barcode', { length: 64 }),
  category: varchar('category', { length: 80 }),
  price: integer('price').notNull(),
  cost: integer('cost'),
  stockAlert: integer('stock_alert').notNull().default(5),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncSeq: bigint('sync_seq', { mode: 'number' }).notNull(),
  firstSyncSeq: bigint('first_sync_seq', { mode: 'number' }).notNull(),
});

export const cashSessions = pgTable('cash_sessions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  staffId: uuid('staff_id').notNull(),
  terminalLabel: varchar('terminal_label', { length: 40 }),
  openedAt: bigint('opened_at', { mode: 'number' }).notNull(),
  closedAt: bigint('closed_at', { mode: 'number' }),
  openingAmount: integer('opening_amount').notNull(),
  closingAmount: integer('closing_amount'),
  expectedAmount: integer('expected_amount'),
  difference: integer('difference'),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  notes: varchar('notes', { length: 500 }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  syncSeq: bigint('sync_seq', { mode: 'number' }).notNull(),
  firstSyncSeq: bigint('first_sync_seq', { mode: 'number' }).notNull(),
});

export type CashSession = typeof cashSessions.$inferSelect;
export type NewCashSession = typeof cashSessions.$inferInsert;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export const checkIns = pgTable('check_ins', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  missionId: uuid('mission_id').notNull(),
  siteId: uuid('site_id'),
  agentId: uuid('agent_id').notNull(),
  checkInTime: bigint('check_in_time', { mode: 'number' }).notNull(),
  checkOutTime: bigint('check_out_time', { mode: 'number' }),
  checkInLat: doublePrecision('check_in_lat').notNull(),
  checkInLng: doublePrecision('check_in_lng').notNull(),
  checkInMethod: text('check_in_method').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncSeq: bigint('sync_seq', { mode: 'number' }),
});

// Append-only. Written by the observability interceptor, read via raw
// SQL from ops tooling. Indexes are declared in migration 014, not here,
// to avoid a mismatch on the DESC ordering (Drizzle does not express
// DESC in pgTable index declarations).
export const syncLogs = pgTable('sync_logs', {
  id: uuid('id').primaryKey(),
  requestId: uuid('request_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  agentId: uuid('agent_id'),
  operation: text('operation').notNull(),
  statusCode: bigint('status_code', { mode: 'number' }).notNull(),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  durationMs: bigint('duration_ms', { mode: 'number' }).notNull(),
  recordsIn: bigint('records_in', { mode: 'number' }).notNull(),
  recordsOut: bigint('records_out', { mode: 'number' }).notNull(),
  conflicts: bigint('conflicts', { mode: 'number' }).notNull(),
  errors: bigint('errors', { mode: 'number' }).notNull(),
  idempotency: text('idempotency'),
  schemaVersion: text('schema_version'),
  errorCode: text('error_code'),
});

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;
export type CheckIn = typeof checkIns.$inferSelect;
export type NewCheckIn = typeof checkIns.$inferInsert;
export type SyncDatabase = typeof import('./schema.js');

export const syncConflicts = pgTable('sync_conflicts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  agentId: uuid('agent_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  clientVersion: bigint('client_version', { mode: 'number' }).notNull(),
  serverVersion: bigint('server_version', { mode: 'number' }).notNull(),
  clientPayload: jsonb('client_payload').notNull(),
  serverPayload: jsonb('server_payload').notNull(),
  status: text('status').notNull().default('pending'),
  resolution: text('resolution'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: bigint('resolved_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    checkInId: uuid('check_in_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    uploadedAt: bigint('uploaded_at', { mode: 'number' }),
  },
  (table) => ({
    objectKeyIdx: uniqueIndex('attachments_object_key_idx').on(table.objectKey),
    tenantCheckInIdx: index('attachments_tenant_check_in_idx').on(table.tenantId, table.checkInId),
    tenantStatusIdx: index('attachments_tenant_status_idx').on(table.tenantId, table.status),
    fkCheckInTenant: foreignKey({
      columns: [table.checkInId, table.tenantId],
      foreignColumns: [checkIns.id, checkIns.tenantId],
      name: 'fk_attachments_check_in_tenant',
    }).onDelete('cascade'),
  })
);
