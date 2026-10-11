import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { PromotionConditions } from '@shared/promotions';
import { createdAt, pk, ts, updatedAt } from './_common';
import { branches, organizations, users } from './core';
import { orders } from './orders';

/** Customer profiles — only the contact data needed for service and loyalty (PDPA minimisation). */
export const customers = pgTable(
  'customers',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text('name').notNull(),
    /** Digits only, e.g. 0812345678. */
    phone: text('phone'),
    email: text('email'),
    lineId: text('line_id'),
    birthDate: date('birth_date'),
    allergies: text('allergies'),
    notes: text('notes'),
    tier: text('tier'),
    /** Cached from loyalty_transactions. */
    pointsBalance: integer('points_balance').notNull().default(0),
    lifetimeSpendSatang: integer('lifetime_spend_satang').notNull().default(0),
    visitCount: integer('visit_count').notNull().default(0),
    lastVisitAt: ts('last_visit_at'),
    consentMarketing: boolean('consent_marketing').notNull().default(false),
    consentAt: ts('consent_at'),
    consentSource: text('consent_source'),
    anonymizedAt: ts('anonymized_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('customers_org_phone_uq').on(t.organizationId, t.phone).where(sql`phone is not null`), index('customers_org_name_idx').on(t.organizationId, t.name)],
);

export const LOYALTY_TYPES = ['EARN', 'REDEEM', 'ADJUST', 'EXPIRE', 'REVERSE'] as const;

/** Points ledger; customers.points_balance is a cache of its sum. */
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    type: text('type', { enum: LOYALTY_TYPES }).notNull(),
    points: integer('points').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    paymentId: uuid('payment_id'),
    reason: text('reason'),
    expiresAt: ts('expires_at'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('loyalty_customer_idx').on(t.customerId, t.createdAt), uniqueIndex('loyalty_idem_uq').on(t.idempotencyKey).where(sql`idempotency_key is not null`)],
);

export const promotions = pgTable('promotions', {
  id: pk(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type', { enum: ['PERCENT_BILL', 'AMOUNT_BILL', 'PERCENT_ITEM', 'BUY_X_GET_Y'] }).notNull(),
  value: integer('value').notNull().default(0),
  conditions: jsonb('conditions').$type<PromotionConditions>().notNull().default({}),
  /** When true the promotion can only be applied with a coupon code. */
  requiresCoupon: boolean('requires_coupon').notNull().default(false),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  usageLimitTotal: integer('usage_limit_total'),
  usageLimitPerCustomer: integer('usage_limit_per_customer'),
  stackable: boolean('stackable').notNull().default(false),
  active: boolean('active').notNull().default(true),
  archivedAt: ts('archived_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Coupon codes; maxUses 1 = single-use. Optionally issued to one customer (e.g. birthday). */
export const coupons = pgTable(
  'coupons',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    promotionId: uuid('promotion_id').notNull().references(() => promotions.id),
    code: text('code').notNull(),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    customerId: uuid('customer_id').references(() => customers.id),
    expiresAt: ts('expires_at'),
    disabledAt: ts('disabled_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('coupons_org_code_uq').on(t.organizationId, t.code)],
);

/** One row per promotion applied to an order; counted for usage limits unless voided. */
export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    promotionId: uuid('promotion_id').notNull().references(() => promotions.id),
    couponId: uuid('coupon_id').references(() => coupons.id),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    customerId: uuid('customer_id').references(() => customers.id),
    orderDiscountId: uuid('order_discount_id'),
    discountSatang: integer('discount_satang').notNull(),
    status: text('status', { enum: ['APPLIED', 'VOIDED'] }).notNull().default('APPLIED'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('promo_redemption_active_uq').on(t.orderId, t.promotionId).where(sql`status = 'APPLIED'`), index('promo_redemption_promo_idx').on(t.promotionId)],
);
