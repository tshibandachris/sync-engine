import {
  bigint,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
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
