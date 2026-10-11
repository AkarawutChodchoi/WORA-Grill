import { date, index, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common';
import { branches, organizations, users } from './core';
import { ingredients, warehouses } from './inventory';

/** HR details for a user. Payroll/SSO/WHT/OT are intentionally out of scope (Prompt 15 rule). */
export const staffProfiles = pgTable('staff_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  position: text('position'),
  wageType: text('wage_type', { enum: ['HOURLY', 'DAILY', 'MONTHLY'] }),
  /** Satang per hour / per day / per month according to wageType. */
  wageRateSatang: integer('wage_rate_satang'),
  startDate: date('start_date'),
  emergencyContact: text('emergency_contact'),
  notes: text('notes'),
  updatedAt: updatedAt(),
});

/** Planned shifts (ตารางกะ). */
export const staffShifts = pgTable(
  'staff_shifts',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    position: text('position'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('staff_shifts_branch_time_idx').on(t.branchId, t.startsAt), index('staff_shifts_user_idx').on(t.userId, t.startsAt)],
);

/** Clock-in/out records. Edits by a manager keep who/why. */
export const attendance = pgTable(
  'attendance',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    clockInAt: ts('clock_in_at').notNull(),
    clockOutAt: ts('clock_out_at'),
    source: text('source', { enum: ['PIN', 'WEB', 'MANUAL'] }).notNull(),
    editedBy: uuid('edited_by').references(() => users.id),
    editReason: text('edit_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('attendance_user_idx').on(t.userId, t.clockInAt), index('attendance_branch_idx').on(t.branchId, t.clockInAt)],
);

/** Stock moving between branches (incl. central kitchen → branch). */
export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    transferNo: text('transfer_no').notNull(),
    fromBranchId: uuid('from_branch_id').notNull().references(() => branches.id),
    fromWarehouseId: uuid('from_warehouse_id').references(() => warehouses.id),
    toBranchId: uuid('to_branch_id').notNull().references(() => branches.id),
    toWarehouseId: uuid('to_warehouse_id').references(() => warehouses.id),
    status: text('status', { enum: ['REQUESTED', 'SHIPPED', 'RECEIVED', 'CANCELLED'] }).notNull(),
    note: text('note'),
    requestedBy: uuid('requested_by').references(() => users.id),
    shippedBy: uuid('shipped_by').references(() => users.id),
    shippedAt: ts('shipped_at'),
    receivedBy: uuid('received_by').references(() => users.id),
    receivedAt: ts('received_at'),
    createdAt: createdAt(),
  },
  (t) => [index('stock_transfers_from_idx').on(t.fromBranchId), index('stock_transfers_to_idx').on(t.toBranchId)],
);

export const stockTransferLines = pgTable('stock_transfer_lines', {
  id: pk(),
  transferId: uuid('transfer_id')
    .notNull()
    .references(() => stockTransfers.id, { onDelete: 'cascade' }),
  ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
  requestedQtyBase: numeric('requested_qty_base', { precision: 18, scale: 4 }).notNull(),
  shippedQtyBase: numeric('shipped_qty_base', { precision: 18, scale: 4 }),
  receivedQtyBase: numeric('received_qty_base', { precision: 18, scale: 4 }),
  unitCost: numeric('unit_cost', { precision: 18, scale: 6 }),
  discrepancyReason: text('discrepancy_reason'),
});
