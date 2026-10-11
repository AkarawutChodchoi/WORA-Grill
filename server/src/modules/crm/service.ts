import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { localParts } from '@shared/menu';
import { evaluatePromotion, pointsToEarn, tierFor, type PromoContext, type PromotionRule } from '@shared/promotions';
import { resolveOrgSettings } from '@shared/settings';
import type { DbOrTx } from '../../db/client';
import { branches, coupons, customers, loyaltyTransactions, menuItems, orderDiscounts, orderItems, organizations, payments, promotionRedemptions, promotions } from '../../db/schema';
import { LOYALTY_TYPES } from '../../db/schema/crm';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { orderHooks } from '../orders/hooks';
import { orderDetailExtensions, recalcOrder, type Order } from '../orders/service';

export async function orgSettings(db: DbOrTx, orgId: string) {
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return resolveOrgSettings(o?.settings);
}

/** Append a points transaction and update the cached balance under a row lock. Idempotent by key. */
export async function postPoints(
  db: DbOrTx,
  p: { orgId: string; customerId: string; type: (typeof LOYALTY_TYPES)[number]; points: number; orderId?: string | null; paymentId?: string | null; reason?: string; idempotencyKey?: string; expiresAt?: Date | null; createdBy?: string | null },
) {
  if (p.points === 0) return null;
  if (p.idempotencyKey) {
    const [dup] = await db.select({ id: loyaltyTransactions.id }).from(loyaltyTransactions).where(eq(loyaltyTransactions.idempotencyKey, p.idempotencyKey));
    if (dup) return null;
  }
  const [c] = await db.select().from(customers).where(and(eq(customers.id, p.customerId), eq(customers.organizationId, p.orgId))).for('update');
  if (!c) throw notFound('ลูกค้า');
  const next = c.pointsBalance + p.points;
  if (next < 0) throw unprocessable(`แต้มไม่พอ (คงเหลือ ${c.pointsBalance})`, 'INSUFFICIENT_POINTS');
  const [t] = await db
    .insert(loyaltyTransactions)
    .values({ organizationId: p.orgId, customerId: p.customerId, type: p.type, points: p.points, orderId: p.orderId ?? null, paymentId: p.paymentId ?? null, reason: p.reason, idempotencyKey: p.idempotencyKey, expiresAt: p.expiresAt ?? null, createdBy: p.createdBy ?? null })
    .returning();
  await db.update(customers).set({ pointsBalance: next }).where(eq(customers.id, p.customerId));
  return t;
}

/**
 * Expire points FIFO: points used are taken from the oldest earnings first, so the amount to expire is
 * (earned with expiry ≤ now) − (everything already spent, reversed or expired), never below zero.
 */
export async function expirePoints(db: DbOrTx, orgId: string, customerId: string, now = new Date()) {
  const rows = await db.select().from(loyaltyTransactions).where(eq(loyaltyTransactions.customerId, customerId));
  const expiredEarned = rows.filter((r) => r.type === 'EARN' && r.expiresAt && r.expiresAt <= now).reduce((a, r) => a + r.points, 0);
  const consumed = -rows.filter((r) => r.points < 0).reduce((a, r) => a + r.points, 0);
  const toExpire = Math.max(0, expiredEarned - consumed);
  if (!toExpire) return 0;
  await postPoints(db, { orgId, customerId, type: 'EXPIRE', points: -toExpire, reason: 'แต้มหมดอายุ', idempotencyKey: `EXPIRE:${customerId}:${now.toISOString().slice(0, 10)}:${toExpire}` });
  return toExpire;
}

async function promoContext(db: DbOrTx, order: Order, excludeDiscountId?: string): Promise<{ ctx: Omit<PromoContext, 'usage' | 'appliedPromotions'>; applied: { id: string; stackable: boolean; discountId: string }[] }> {
  const items = await db
    .select({ menuItemId: orderItems.menuItemId, unitPriceSatang: orderItems.unitPriceSatang, qty: orderItems.qty, discountSatang: orderItems.discountSatang, categoryId: menuItems.categoryId })
    .from(orderItems)
    .leftJoin(menuItems, eq(menuItems.id, orderItems.menuItemId))
    .where(and(eq(orderItems.orderId, order.id), ne(orderItems.status, 'CANCELLED')));
  const discounts = await db
    .select({ d: orderDiscounts, stackable: promotions.stackable })
    .from(orderDiscounts)
    .leftJoin(promotions, eq(promotions.id, orderDiscounts.promotionId))
    .where(and(eq(orderDiscounts.orderId, order.id), isNull(orderDiscounts.removedAt)))
    .orderBy(asc(orderDiscounts.createdAt));
  const others = discounts.filter((x) => x.d.id !== excludeDiscountId);
  const itemDisc = items.reduce((a, i) => a + i.discountSatang, 0);
  // Promotions apply after item discounts and after bill discounts that were added earlier.
  const earlierBill = others.filter((x) => x.d.scope === 'BILL' && (!excludeDiscountId || x.d.createdAt < (discounts.find((y) => y.d.id === excludeDiscountId)?.d.createdAt ?? new Date(8.64e15)))).reduce((a, x) => a + x.d.amountSatang, 0);
  const subtotal = items.reduce((a, i) => a + i.unitPriceSatang * i.qty, 0) - itemDisc - earlierBill;
  const [b] = await db.select({ timezone: branches.timezone }).from(branches).where(eq(branches.id, order.branchId));
  const now = new Date();
  const { day, minutes } = localParts(now, b.timezone);
  let customer = null;
  if (order.customerId) {
    const [c] = await db.select({ id: customers.id, tier: customers.tier }).from(customers).where(eq(customers.id, order.customerId));
    customer = c ?? null;
  }
  return {
    ctx: { subtotalSatang: Math.max(0, subtotal), lines: items.map((i) => ({ menuItemId: i.menuItemId, categoryId: i.categoryId, unitPriceSatang: i.unitPriceSatang, qty: i.qty })), channel: order.channel, branchId: order.branchId, localDay: day, localMinutes: minutes, now, customer },
    applied: others.filter((x) => x.d.promotionId).map((x) => ({ id: x.d.promotionId!, stackable: !!x.stackable, discountId: x.d.id })),
  };
}

export function toRule(p: typeof promotions.$inferSelect): PromotionRule {
  return { id: p.id, name: p.name, type: p.type, value: p.value, conditions: p.conditions, startsAt: p.startsAt, endsAt: p.endsAt, usageLimitTotal: p.usageLimitTotal, usageLimitPerCustomer: p.usageLimitPerCustomer, stackable: p.stackable, active: p.active && !p.archivedAt };
}

async function usageOf(db: DbOrTx, promotionId: string, customerId: string | null, excludeOrderId?: string) {
  const base = and(eq(promotionRedemptions.promotionId, promotionId), eq(promotionRedemptions.status, 'APPLIED'), excludeOrderId ? ne(promotionRedemptions.orderId, excludeOrderId) : undefined);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(promotionRedemptions).where(base);
  let byCustomer = 0;
  if (customerId) [{ total: byCustomer }] = await db.select({ total: sql<number>`count(*)::int` }).from(promotionRedemptions).where(and(base, eq(promotionRedemptions.customerId, customerId)));
  return { total, byCustomer };
}

/** Validate and apply a promotion (optionally via coupon) to a locked order. */
export async function applyPromotion(db: DbOrTx, order: Order, actorId: string, input: { promotionId?: string; code?: string }) {
  let promo: typeof promotions.$inferSelect | undefined;
  let coupon: typeof coupons.$inferSelect | undefined;
  if (input.code) {
    [coupon] = await db
      .select()
      .from(coupons)
      .where(and(eq(coupons.organizationId, order.organizationId), eq(coupons.code, input.code.trim().toUpperCase())))
      .for('update');
    if (!coupon || coupon.disabledAt) throw unprocessable('ไม่พบคูปองหรือคูปองถูกปิดใช้งาน', 'PROMO_INVALID');
    if (coupon.expiresAt && coupon.expiresAt <= new Date()) throw unprocessable('คูปองหมดอายุแล้ว', 'PROMO_INVALID');
    if (coupon.usedCount >= coupon.maxUses) throw unprocessable('คูปองนี้ถูกใช้ครบแล้ว', 'PROMO_INVALID');
    if (coupon.customerId && coupon.customerId !== order.customerId) throw unprocessable('คูปองนี้ใช้ได้เฉพาะลูกค้าที่ได้รับ', 'PROMO_INVALID');
    [promo] = await db.select().from(promotions).where(eq(promotions.id, coupon.promotionId));
  } else if (input.promotionId) {
    [promo] = await db.select().from(promotions).where(and(eq(promotions.id, input.promotionId), eq(promotions.organizationId, order.organizationId)));
    if (promo?.requiresCoupon) throw unprocessable('โปรโมชันนี้ต้องใช้รหัสคูปอง', 'PROMO_INVALID');
  }
  if (!promo || promo.organizationId !== order.organizationId) throw notFound('โปรโมชัน');
  const { ctx, applied } = await promoContext(db, order);
  const usage = await usageOf(db, promo.id, order.customerId);
  const r = evaluatePromotion(toRule(promo), { ...ctx, usage, appliedPromotions: applied });
  if (!r.ok) throw unprocessable(r.reason, 'PROMO_NOT_ELIGIBLE');
  if (coupon) {
    const upd = await db
      .update(coupons)
      .set({ usedCount: sql`${coupons.usedCount} + 1` })
      .where(and(eq(coupons.id, coupon.id), sql`${coupons.usedCount} < ${coupons.maxUses}`))
      .returning({ id: coupons.id });
    if (!upd.length) throw conflict('คูปองนี้ถูกใช้ครบแล้ว', 'PROMO_INVALID');
  }
  // Percent-of-bill stays dynamic; item/BOGO/amount promotions snapshot their computed amount.
  const [d] = await db
    .insert(orderDiscounts)
    .values({
      orderId: order.id,
      organizationId: order.organizationId,
      branchId: order.branchId,
      scope: 'BILL',
      type: promo.type === 'PERCENT_BILL' ? 'PERCENT' : 'AMOUNT',
      value: promo.type === 'PERCENT_BILL' ? promo.value : r.amountSatang,
      reason: `โปรโมชัน: ${promo.name}`,
      promotionId: promo.id,
      couponCode: coupon?.code ?? null,
      createdBy: actorId,
    })
    .returning();
  await db.insert(promotionRedemptions).values({ organizationId: order.organizationId, branchId: order.branchId, promotionId: promo.id, couponId: coupon?.id ?? null, orderId: order.id, customerId: order.customerId, orderDiscountId: d.id, discountSatang: r.amountSatang, createdBy: actorId });
  await recalcOrder(db, order.id);
  return { promotion: promo, amountSatang: r.amountSatang };
}

async function voidRedemptionForDiscount(db: DbOrTx, discountId: string) {
  const [red] = await db
    .update(promotionRedemptions)
    .set({ status: 'VOIDED' })
    .where(and(eq(promotionRedemptions.orderDiscountId, discountId), eq(promotionRedemptions.status, 'APPLIED')))
    .returning();
  if (red?.couponId) await db.update(coupons).set({ usedCount: sql`greatest(${coupons.usedCount} - 1, 0)` }).where(eq(coupons.id, red.couponId));
}

/**
 * Before money is taken, re-check every promotion on the bill against the current lines/customer/time.
 * Ineligible promotions are removed (and the caller is told); amounts of item-based promotions are refreshed.
 */
export async function revalidatePromotions(db: DbOrTx, order: Order) {
  const discs = await db
    .select({ d: orderDiscounts, p: promotions })
    .from(orderDiscounts)
    .innerJoin(promotions, eq(promotions.id, orderDiscounts.promotionId))
    .where(and(eq(orderDiscounts.orderId, order.id), isNull(orderDiscounts.removedAt)))
    .orderBy(asc(orderDiscounts.createdAt));
  const removed: string[] = [];
  let changed = false;
  for (const { d, p } of discs) {
    const { ctx, applied } = await promoContext(db, order, d.id);
    const usage = await usageOf(db, p.id, order.customerId, order.id);
    const rule = toRule(p);
    // A coupon-based promotion already consumed its coupon use; only re-check the rule itself.
    const r = evaluatePromotion(rule, { ...ctx, usage, appliedPromotions: applied.filter((x) => x.discountId !== d.id) });
    if (!r.ok) {
      await db.update(orderDiscounts).set({ removedAt: new Date() }).where(eq(orderDiscounts.id, d.id));
      await voidRedemptionForDiscount(db, d.id);
      removed.push(`นำโปรโมชัน ${p.name} ออก (${r.reason})`);
      changed = true;
    } else if (d.type === 'AMOUNT' && d.value !== r.amountSatang) {
      await db.update(orderDiscounts).set({ value: r.amountSatang }).where(eq(orderDiscounts.id, d.id));
      await db.update(promotionRedemptions).set({ discountSatang: r.amountSatang }).where(eq(promotionRedemptions.orderDiscountId, d.id));
      removed.push(`ส่วนลด ${p.name} เปลี่ยนเป็น ${(r.amountSatang / 100).toFixed(2)} บาท`);
      changed = true;
    }
  }
  if (changed) await recalcOrder(db, order.id);
  return removed;
}

let registered = false;
/** Wire loyalty & promotions into the order lifecycle. */
export function registerCrmHooks() {
  if (registered) return;
  registered = true;

  orderHooks.beforePayment.push(async (ctx, order) => revalidatePromotions(ctx.db, order));

  orderHooks.discountRemoved.push(async (ctx, discountId) => voidRedemptionForDiscount(ctx.db, discountId));

  orderHooks.orderVoided.push(async (ctx, order) => {
    const ds = await ctx.db.select({ id: orderDiscounts.id }).from(orderDiscounts).where(eq(orderDiscounts.orderId, order.id));
    for (const d of ds) await voidRedemptionForDiscount(ctx.db, d.id);
  });

  // Earn points when a member's bill is fully paid (not on the part paid with points).
  orderHooks.orderPaid.push(async (ctx, order) => {
    if (!order.customerId) return;
    const s = await orgSettings(ctx.db, order.organizationId);
    const pays = await ctx.db.select().from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, 'CONFIRMED')));
    const viaPoints = pays.filter((p) => p.method === 'POINTS').reduce((a, p) => a + p.amountSatang - p.refundedSatang, 0);
    const [c] = await ctx.db.select().from(customers).where(eq(customers.id, order.customerId));
    if (!c || c.anonymizedAt) return;
    const lifetime = c.lifetimeSpendSatang + order.grandTotalSatang;
    const tier = tierFor(lifetime, s.loyalty.tiers);
    await ctx.db.update(customers).set({ lifetimeSpendSatang: lifetime, visitCount: c.visitCount + 1, lastVisitAt: new Date(), tier: tier?.code ?? null }).where(eq(customers.id, c.id));
    if (!s.loyalty.enabled) return;
    const currentTier = tierFor(c.lifetimeSpendSatang, s.loyalty.tiers);
    const points = pointsToEarn(order.grandTotalSatang - viaPoints, s.loyalty.pointsPer100Baht, currentTier?.earnMultiplierBps ?? 10_000);
    const expiresAt = s.loyalty.expiryMonths ? new Date(Date.now() + s.loyalty.expiryMonths * 30 * 86_400_000) : null;
    await postPoints(ctx.db, { orgId: order.organizationId, customerId: c.id, type: 'EARN', points, orderId: order.id, reason: `บิล #${order.orderNo}`, idempotencyKey: `EARN:${order.id}:${order.paidAt?.getTime() ?? 0}`, expiresAt, createdBy: ctx.actor.userId });
  });

  // A fully refunded bill loses the points it earned.
  orderHooks.orderReopened.push(async (ctx, order) => {
    const earns = await ctx.db.select().from(loyaltyTransactions).where(and(eq(loyaltyTransactions.orderId, order.id), eq(loyaltyTransactions.type, 'EARN')));
    for (const e of earns) {
      const [c] = await ctx.db.select({ bal: customers.pointsBalance }).from(customers).where(eq(customers.id, e.customerId));
      await postPoints(ctx.db, { orgId: order.organizationId, customerId: e.customerId, type: 'REVERSE', points: -Math.min(e.points, c.bal), orderId: order.id, reason: 'คืนเงินทั้งบิล', idempotencyKey: `REV_EARN:${e.id}` });
    }
  });

  // Refunding a points payment gives the points back.
  orderHooks.paymentRefunded.push(async (ctx, payment, amount) => {
    if (payment.method !== 'POINTS') return;
    const [red] = await ctx.db.select().from(loyaltyTransactions).where(and(eq(loyaltyTransactions.paymentId, payment.id), eq(loyaltyTransactions.type, 'REDEEM')));
    if (!red) return;
    const s = await orgSettings(ctx.db, red.organizationId);
    const pts = Math.floor(amount / Math.max(1, s.loyalty.pointValueSatang));
    await postPoints(ctx.db, { orgId: red.organizationId, customerId: red.customerId, type: 'REVERSE', points: pts, orderId: payment.orderId, paymentId: payment.id, reason: 'คืนแต้มจากการคืนเงิน', idempotencyKey: `REV_REDEEM:${payment.id}:${Date.now()}` });
  });

  // Show the attached member on order screens (masked contact).
  orderDetailExtensions.push(async (db, o) => {
    if (!o.customerId) return { customer: null };
    const [c] = await db
      .select({ id: customers.id, name: customers.name, phone: customers.phone, tier: customers.tier, pointsBalance: customers.pointsBalance, allergies: customers.allergies })
      .from(customers)
      .where(eq(customers.id, o.customerId));
    return { customer: c ? { ...c, phone: maskPhone(c.phone) } : null };
  });
}

export function maskPhone(p: string | null) {
  return p ? `${p.slice(0, 3)}-xxx-${p.slice(-4)}` : null;
}

export async function promotionsApplicable(db: DbOrTx, orgId: string) {
  return db
    .select()
    .from(promotions)
    .where(and(eq(promotions.organizationId, orgId), eq(promotions.active, true), isNull(promotions.archivedAt), eq(promotions.requiresCoupon, false)))
    .orderBy(asc(promotions.name));
}

