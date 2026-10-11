import { index, integer, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { TABLE_STATUSES } from '@shared/states';
import { createdAt, pk, ts } from './_common';
import { branches, organizations, users } from './core';

export const zones = pgTable('zones', {
  id: pk(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  name: text('name').notNull(),
  floor: text('floor'),
  sort: integer('sort').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
});

/** Waiters responsible for a zone (SPEC §3.2 ผูกพนักงานเสิร์ฟกับโซน). */
export const zoneWaiters = pgTable(
  'zone_waiters',
  {
    zoneId: uuid('zone_id').notNull().references(() => zones.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.zoneId, t.userId] })],
);

export const diningTables = pgTable(
  'tables',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    zoneId: uuid('zone_id').notNull().references(() => zones.id),
    name: text('name').notNull(),
    capacity: integer('capacity').notNull().default(4),
    shape: text('shape', { enum: ['square', 'round', 'rect'] }).notNull().default('square'),
    /** Floor-plan grid position and size. */
    posX: integer('pos_x').notNull().default(0),
    posY: integer('pos_y').notNull().default(0),
    width: integer('width').notNull().default(2),
    height: integer('height').notNull().default(2),
    status: text('status', { enum: TABLE_STATUSES }).notNull().default('AVAILABLE'),
    /** Active order seated at this table (null when free). */
    currentOrderId: uuid('current_order_id'),
    /** When joined to another table for a large party, the primary table it belongs to. */
    mergedIntoTableId: uuid('merged_into_table_id'),
    statusChangedAt: ts('status_changed_at').notNull().defaultNow(),
    /** Optimistic concurrency counter, bumped on every state change. */
    version: integer('version').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('tables_branch_name_uq').on(t.branchId, t.name), index('tables_zone_idx').on(t.zoneId)],
);
