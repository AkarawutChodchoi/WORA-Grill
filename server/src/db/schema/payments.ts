import { sql } from 'drizzle-orm';
import { date, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts } from './_common';
import { branches, organizations, users } from './core';
import { orders } from './orders';

export const PAYMENT_METHODS = ['CASH', 'PROMPTPAY', 'CARD', 'EWALLET', 'TRANSFER', 'VOUCHER', 'POINTS', 'STORED_VALUE'] as const;
export const PAYMENT_STATUSES = ['PENDING_CONFIRMATION', 'CONFIRMED', 'VOIDED'] as const;

/** Cashier shifts with opening float and close-out count (SPEC §3.1 กะและลิ้นชักเงิน). */
export const shifts = pgTable(
  'shifts',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    deviceId: uuid('device_id'),
    businessDate: date('business_date').notNull(),
    status: text('status', { enum: ['OPEN', 'CLOSED'] }).notNull().default('OPEN'),
    openingFloatSatang: integer('opening_float_satang').notNull(),
    expectedCashSatang: integer('expected_cash_satang'),
    countedCashSatang: integer('counted_cash_satang'),
    varianceSatang: integer('variance_satang'),
    /** Denomination breakdown entered at close. */
    countDetail: jsonb('count_detail').$type<Record<string, number>>(),
    closeNote: text('close_note'),
    /** Frozen Z-report snapshot. */
    zReport: jsonb('z_report').$type<Record<string, unknown>>(),
    openedAt: ts('opened_at').notNull().defaultNow(),
    closedAt: ts('closed_at'),
    closedBy: uuid('closed_by').references(() => users.id),
  },
  (t) => [
    index('shifts_branch_date_idx').on(t.branchId, t.businessDate),
    // One open shift per cashier per branch.
    uniqueIndex('shifts_open_user_uq').on(t.branchId, t.userId).where(sql`status = 'OPEN'`),
  ],
);

export const cashMovements = pgTable(
  'cash_movements',
  {
    id: pk(),
    shiftId: uuid('shift_id').notNull().references(() => shifts.id),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    type: text('type', { enum: ['PAY_IN', 'PAY_OUT', 'NO_SALE'] }).notNull(),
    amountSatang: integer('amount_satang').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('cash_movements_shift_idx').on(t.shiftId)],
);

/**
 * Money received against a bill. `id` can be client-generated for idempotent retries;
 * `provider_ref` is unique so gateway webhooks cannot double-record.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    shiftId: uuid('shift_id').references(() => shifts.id),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
    /** Amount applied to the bill. */
    amountSatang: integer('amount_satang').notNull(),
    /** Cash handed over (cash only). */
    tenderedSatang: integer('tendered_satang'),
    changeSatang: integer('change_satang').notNull().default(0),
    refundedSatang: integer('refunded_satang').notNull().default(0),
    /** EDC approval code, transfer slip ref, voucher code… (never full card numbers). */
    reference: text('reference'),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    createdBy: uuid('created_by').references(() => users.id),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmedAt: ts('confirmed_at'),
    voidedAt: ts('voided_at'),
    voidedBy: uuid('voided_by').references(() => users.id),
    /** Recorded while the POS was offline; confirmed when synced (Prompt 16). */
    offlineRecordedAt: ts('offline_recorded_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_order_idx').on(t.orderId),
    index('payments_shift_idx').on(t.shiftId),
    index('payments_branch_created_idx').on(t.branchId, t.createdAt),
    uniqueIndex('payments_provider_ref_uq').on(t.provider, t.providerRef).where(sql`provider_ref is not null`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    paymentId: uuid('payment_id').notNull().references(() => payments.id),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    shiftId: uuid('shift_id').references(() => shifts.id),
    method: text('method').notNull(),
    amountSatang: integer('amount_satang').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('refunds_order_idx').on(t.orderId), index('refunds_shift_idx').on(t.shiftId)],
);

/** Running document numbers (receipts, tax invoices, POs…) per branch, type and period. */
export const docCounters = pgTable(
  'doc_counters',
  {
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    docType: text('doc_type').notNull(),
    period: text('period').notNull(),
    lastNo: integer('last_no').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.branchId, t.docType, t.period] })],
);

/** Full tax invoices issued on request (ใบกำกับภาษีเต็มรูป). One active invoice per order. */
export const taxInvoices = pgTable(
  'tax_invoices',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    invoiceNo: text('invoice_no').notNull(),
    buyerName: text('buyer_name').notNull(),
    buyerTaxId: text('buyer_tax_id').notNull(),
    buyerAddress: text('buyer_address').notNull(),
    buyerBranch: text('buyer_branch'),
    /** Frozen totals and seller details at issue time. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    issuedBy: uuid('issued_by').references(() => users.id),
    issuedAt: ts('issued_at').notNull().defaultNow(),
    cancelledAt: ts('cancelled_at'),
  },
  (t) => [uniqueIndex('tax_invoices_order_active_uq').on(t.orderId).where(sql`cancelled_at is null`), uniqueIndex('tax_invoices_no_uq').on(t.branchId, t.invoiceNo)],
);
