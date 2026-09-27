import {
  bigint,
  doublePrecision,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey(),
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
  missionId: uuid('mission_id').notNull(),
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