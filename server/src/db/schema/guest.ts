import { date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common';
import { branches, organizations, users } from './core';
import { customers } from './crm';
import { orders } from './orders';
import { diningTables, zones } from './tables';

export const RESERVATION_STATUSES = ['BOOKED', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;

export const reservations = pgTable(
  'reservations',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    customerId: uuid('customer_id').references(() => customers.id),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    partySize: integer('party_size').notNull(),
    reservedAt: ts('reserved_at').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    zoneId: uuid('zone_id').references(() => zones.id),
    tableId: uuid('table_id').references(() => diningTables.id),
    status: text('status', { enum: RESERVATION_STATUSES }).notNull().default('BOOKED'),
    channel: text('channel', { enum: ['PHONE', 'WALK_IN', 'LINE', 'WEB'] }).notNull().default('PHONE'),
    depositSatang: integer('deposit_satang').notNull().default(0),
    depositStatus: text('deposit_status', { enum: ['NONE', 'PENDING', 'PAID', 'REFUNDED', 'FORFEITED'] }).notNull().default('NONE'),
    notes: text('notes'),
    orderId: uuid('order_id').references(() => orders.id),
    cancelledReason: text('cancelled_reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('reservations_branch_time_idx').on(t.branchId, t.reservedAt)],
);

/** Walk-in queue (บัตรคิว). `publicToken` lets the guest follow their position on a phone. */
export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    businessDate: date('business_date').notNull(),
    queueNo: integer('queue_no').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    partySize: integer('party_size').notNull(),
    status: text('status', { enum: ['WAITING', 'CALLED', 'SEATED', 'LEFT'] }).notNull().default('WAITING'),
    publicToken: text('public_token').notNull(),
    tableId: uuid('table_id').references(() => diningTables.id),
    calledAt: ts('called_at'),
    seatedAt: ts('seated_at'),
    leftAt: ts('left_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('waitlist_day_no_uq').on(t.branchId, t.businessDate, t.queueNo), uniqueIndex('waitlist_token_uq').on(t.publicToken)],
);

/**
 * Table-bound QR ordering session. The guest holds an opaque random token; only its SHA-256 is
 * stored. It is valid only while its order is open, until expiry, and is revoked on rotation.
 */
export const qrSessions = pgTable(
  'qr_sessions',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    tableId: uuid('table_id').references(() => diningTables.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('qr_sessions_token_uq').on(t.tokenHash), index('qr_sessions_order_idx').on(t.orderId)],
);

/** Guest requests from the table (call waiter, water, ice, bill). */
export const serviceRequests = pgTable(
  'service_requests',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    orderId: uuid('order_id').references(() => orders.id),
    tableId: uuid('table_id').references(() => diningTables.id),
    type: text('type', { enum: ['CALL_WAITER', 'WATER', 'ICE', 'BILL', 'OTHER'] }).notNull(),
    note: text('note'),
    status: text('status', { enum: ['OPEN', 'ACKNOWLEDGED', 'DONE'] }).notNull().default('OPEN'),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
    acknowledgedAt: ts('acknowledged_at'),
    doneAt: ts('done_at'),
    createdAt: createdAt(),
  },
  (t) => [index('service_requests_branch_status_idx').on(t.branchId, t.status)],
);

