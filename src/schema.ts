import {
  bigint,
  doublePrecision,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncSeq: bigint('sync_seq', { mode: 'number' }).notNull(),
});

export const missions = pgTable('missions', {
  id: uuid('id').primaryKey(),
  agentId: uuid('agent_id').notNull(),
  siteId: uuid('site_id'),
  title: text('title').notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  syncSeq: bigint('sync_seq', { mode: 'number' }).notNull(),
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

  syncSeq: bigint('sync_seq', { mode: 'number' }).notNull(),
});

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;

export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;

export type CheckIn = typeof checkIns.$inferSelect;
export type NewCheckIn = typeof checkIns.$inferInsert;

export type SyncDatabase = typeof import('./schema.js');