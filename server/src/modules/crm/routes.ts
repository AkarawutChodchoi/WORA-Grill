import { randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orgSettingsSchema } from '@shared/settings';
import { dateString, nonEmpty, reasonSchema, satang, uuid } from '@shared/validation';
import { coupons, customers, loyaltyTransactions, orderItems, orders, organizations, payments, promotionRedemptions, promotions } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAnyPerm, requireBranch, requirePerm, resolvePermissions } from '../../lib/auth';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, parse, unprocessable } from '../../lib/errors';
import { getOrderDetail, lockOrder } from '../orders/service';
import { assertNoMoney, openShiftFor, paidAmount, settleOrder } from '../payments/service';
import { applyPromotion, expirePoints, maskPhone, orgSettings, postPoints, promotionsApplicable, registerCrmHooks } from './service';

registerCrmHooks();

const phoneSchema = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => /^0\d{8,9}$/.test(v), 'เบอร์โทรไม่ถูกต้อง');

const customerBody = z.object({
  name: nonEmpty(100),
  phone: phoneSchema.nullable().optional(),
  email: z.string().trim().email().max(120).nullable().optional().or(z.literal('').transform(() => null)),
  lineId: z.string().trim().max(60).nullable().optional(),
  birthDate: dateString.nullable().optional(),
  allergies: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  consentMarketing: z.boolean().default(false),
  consentSource: z.string().max(40).optional(),
});

const promotionBody = z.object({
  name: nonEmpty(100),
  description: z.string().max(500).nullable().optional(),
  type: z.enum(['PERCENT_BILL', 'AMOUNT_BILL', 'PERCENT_ITEM', 'BUY_X_GET_Y']),
  value: z.number().int().min(0).max(100_000_000),
  conditions: z
    .object({
      minSpendSatang: satang.optional(),
      menuItemIds: z.array(uuid).max(200).optional(),
      categoryIds: z.array(uuid).max(100).optional(),
      buyQty: z.number().int().min(1).max(50).optional(),
      getQty: z.number().int().min(1).max(50).optional(),
      days: z.number().int().min(1).max(127).optional(),
      timeFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      timeTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      branchIds: z.array(uuid).max(100).optional(),
      channels: z.array(z.string().max(20)).max(10).optional(),
      memberOnly: z.boolean().optional(),
      tiers: z.array(z.string().max(20)).max(10).optional(),
    })
    .default({}),
  requiresCoupon: z.boolean().default(false),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  usageLimitTotal: z.number().int().min(1).nullable().optional(),
  usageLimitPerCustomer: z.number().int().min(1).nullable().optional(),
  stackable: z.boolean().default(false),
  active: z.boolean().default(true),
});

function validatePromo(b: z.infer<typeof promotionBody>) {
  if (b.type.startsWith('PERCENT') && (b.value < 1 || b.value > 10_000)) throw badRequest('เปอร์เซ็นต์ต้องอยู่ระหว่าง 0.01–100%');
  if (b.type === 'AMOUNT_BILL' && b.value < 1) throw badRequest('ระบุจำนวนเงินส่วนลด');
  if (b.type === 'BUY_X_GET_Y' && (!b.conditions.buyQty || !b.conditions.getQty || !b.conditions.menuItemIds?.length)) throw badRequest('ซื้อ X แถม Y ต้องระบุจำนวนซื้อ จำนวนแถม และเมนูที่ร่วมรายการ');
  if ((b.conditions.timeFrom == null) !== (b.conditions.timeTo == null)) throw badRequest('ต้องกำหนดเวลาเริ่มและสิ้นสุดคู่กัน');
  if (b.startsAt && b.endsAt && b.startsAt >= b.endsAt) throw badRequest('วันสิ้นสุดต้องหลังวันเริ่ม');
}

export default async function crmRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;
  const emit = (orgId: string, branchId: string, orderId: string) => bus.publish({ type: 'order.updated', organizationId: orgId, branchId, payload: { orderId } });

  // ---------- Customers ----------
  app.get('/customers', async (req) => {
    const a = requirePerm(req, 'customer.view');
    const q = parse(z.object({ q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const conds: SQL[] = [eq(customers.organizationId, a.orgId), isNull(customers.anonymizedAt)];
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      conds.push(or(ilike(customers.name, `%${q.q}%`), digits.length >= 4 ? ilike(customers.phone, `%${digits}%`) : undefined)!);
    }
    const rows = await db.select().from(customers).where(and(...conds)).orderBy(desc(customers.lastVisitAt)).limit(q.limit);
    // List view masks phone numbers; full details need opening the profile.
    return { customers: rows.map((c) => ({ id: c.id, name: c.name, phone: maskPhone(c.phone), tier: c.tier, pointsBalance: c.pointsBalance, visitCount: c.visitCount, lastVisitAt: c.lastVisitAt, consentMarketing: c.consentMarketing })) };
  });

  /** Exact phone lookup at the POS. */
  app.get('/customers/lookup', async (req) => {
    const a = requirePerm(req, 'customer.view');
    const { phone } = parse(z.object({ phone: phoneSchema }), req.query);
    const [c] = await db.select().from(customers).where(and(eq(customers.organizationId, a.orgId), eq(customers.phone, phone), isNull(customers.anonymizedAt)));
    return { customer: c ? { id: c.id, name: c.name, phone: maskPhone(c.phone), tier: c.tier, pointsBalance: c.pointsBalance, allergies: c.allergies } : null };
  });

  app.get('/customers/:id', async (req) => {
    const a = requirePerm(req, 'customer.view');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [c] = await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, a.orgId)));
    if (!c) throw notFound('ลูกค้า');
    const [history, points, favourites] = await Promise.all([
      db
        .select({ id: orders.id, orderNo: orders.orderNo, businessDate: orders.businessDate, channel: orders.channel, status: orders.status, grandTotalSatang: orders.grandTotalSatang })
        .from(orders)
        .where(eq(orders.customerId, id))
        .orderBy(desc(orders.openedAt))
        .limit(50),
      db.select().from(loyaltyTransactions).where(eq(loyaltyTransactions.customerId, id)).orderBy(desc(loyaltyTransactions.createdAt)).limit(100),
      db
        .select({ name: orderItems.nameSnapshot, qty: sql<number>`sum(${orderItems.qty})::int` })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(and(eq(orders.customerId, id), inArray(orders.status, ['PAID', 'CLOSED']), sql`${orderItems.status} <> 'CANCELLED'`))
        .groupBy(orderItems.nameSnapshot)
        .orderBy(sql`sum(${orderItems.qty}) desc`)
        .limit(5),
    ]);
    await audit(db, a, { action: 'customer.view', targetType: 'customer', targetId: id }, req.ip);
    return { customer: c, orders: history, loyalty: points, favourites };
  });

  app.post('/customers', async (req) => {
    const a = requirePerm(req, 'customer.manage');
    const body = parse(customerBody, req.body);
    try {
      const [c] = await db
        .insert(customers)
        .values({
          organizationId: a.orgId,
          ...body,
          phone: body.phone ?? null,
          consentAt: body.consentMarketing ? new Date() : null,
          consentSource: body.consentMarketing ? (body.consentSource ?? 'POS') : null,
          createdBy: a.userId,
        })
        .returning();
      await audit(db, a, { action: 'customer.create', targetType: 'customer', targetId: c.id, data: { consentMarketing: body.consentMarketing } }, req.ip);
      return c;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('เบอร์โทรนี้เป็นสมาชิกอยู่แล้ว');
      throw e;
    }
  });

  app.patch('/customers/:id', async (req) => {
    const a = requirePerm(req, 'customer.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(customerBody.partial(), req.body);
    const [cur] = await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, a.orgId)));
    if (!cur || cur.anonymizedAt) throw notFound('ลูกค้า');
    const consentChanged = body.consentMarketing !== undefined && body.consentMarketing !== cur.consentMarketing;
    try {
      await db
        .update(customers)
        .set({ ...body, ...(consentChanged ? { consentAt: new Date(), consentSource: body.consentSource ?? 'STAFF' } : {}) })
        .where(eq(customers.id, id));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('เบอร์โทรนี้เป็นสมาชิกอยู่แล้ว');
      throw e;
    }
    await audit(db, a, { action: consentChanged ? 'customer.consent_changed' : 'customer.update', targetType: 'customer', targetId: id, data: { fields: Object.keys(body), consentMarketing: body.consentMarketing } }, req.ip);
    return { ok: true };
  });

  /** PDPA: export everything we hold about a customer. */
  app.get('/customers/:id/export', async (req) => {
    const a = requirePerm(req, 'customer.export_pii');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [c] = await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, a.orgId)));
    if (!c) throw notFound('ลูกค้า');
    const os = await db.select({ orderNo: orders.orderNo, date: orders.businessDate, total: orders.grandTotalSatang, status: orders.status }).from(orders).where(eq(orders.customerId, id));
    const pts = await db.select().from(loyaltyTransactions).where(eq(loyaltyTransactions.customerId, id));
    await audit(db, a, { action: 'customer.export_pii', targetType: 'customer', targetId: id }, req.ip);
    return { exportedAt: new Date().toISOString(), customer: c, orders: os, loyaltyTransactions: pts };
  });

  /** PDPA erasure: remove personal data but keep anonymous transactions for accounting. */
  app.post('/customers/:id/anonymize', async (req) => {
    const a = requirePerm(req, 'customer.export_pii');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const [c] = await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, a.orgId)));
    if (!c) throw notFound('ลูกค้า');
    if (c.anonymizedAt) return { ok: true };
    await db
      .update(customers)
      .set({ name: 'ลบข้อมูลตามคำขอ', phone: null, email: null, lineId: null, birthDate: null, allergies: null, notes: null, consentMarketing: false, anonymizedAt: new Date() })
      .where(eq(customers.id, id));
    await db.update(orders).set({ customerName: null, customerPhone: null }).where(eq(orders.customerId, id));
    await audit(db, a, { action: 'customer.anonymize', targetType: 'customer', targetId: id, reason }, req.ip);
    return { ok: true };
  });

  /** Manual points adjustment (e.g. goodwill) — requires loyalty.adjust and a reason. */
  app.post('/customers/:id/points', async (req) => {
    const a = requirePerm(req, 'loyalty.adjust');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ points: z.number().int().min(-100000).max(100000).refine((v) => v !== 0), reason: reasonSchema }), req.body);
    const t = await db.transaction((tx) => postPoints(tx, { orgId: a.orgId, customerId: id, type: 'ADJUST', points: body.points, reason: body.reason, createdBy: a.userId }));
    await audit(db, a, { action: 'loyalty.adjust', targetType: 'customer', targetId: id, reason: body.reason, data: { points: body.points } }, req.ip);
    return t;
  });

  // ---------- Order integration ----------
  app.post('/orders/:id/customer', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { customerId } = parse(z.object({ customerId: uuid.nullable() }), req.body);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      if (customerId) {
        const [c] = await tx.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, a.orgId), isNull(customers.anonymizedAt)));
        if (!c) throw notFound('ลูกค้า');
      }
      if (o.paidSatang > 0 && o.customerId !== customerId) throw conflict('มีการชำระแล้ว เปลี่ยนลูกค้าไม่ได้');
      await tx.update(orders).set({ customerId }).where(eq(orders.id, id));
      await audit(tx, a, { action: 'order.customer', targetType: 'order', targetId: id, data: { customerId } }, req.ip);
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  app.get('/promotions/available', async (req) => {
    const a = requirePerm(req, 'order.create');
    return { promotions: (await promotionsApplicable(db, a.orgId)).map((p) => ({ id: p.id, name: p.name, description: p.description, type: p.type, value: p.value })) };
  });

  app.post('/orders/:id/promotions', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ promotionId: uuid.optional(), code: z.string().trim().min(3).max(40).optional() }).refine((b) => b.promotionId || b.code, 'ระบุโปรโมชันหรือรหัสคูปอง'), req.body);
    const r = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      await assertNoMoney(tx, o.id, 'มีการชำระหรือรอยืนยันการชำระแล้ว ใช้โปรโมชันเพิ่มไม่ได้');
      const res = await applyPromotion(tx, o, a.userId, body);
      await audit(tx, a, { action: 'promotion.apply', targetType: 'order', targetId: id, data: { promotionId: res.promotion.id, code: body.code, amount: res.amountSatang } }, req.ip);
      return res;
    });
    emit(a.orgId, branchId, id);
    return { amountSatang: r.amountSatang, order: await getOrderDetail(db, a.orgId, branchId, id) };
  });

  /** Pay (part of) a bill with loyalty points. Points are deducted in the same transaction. */
  app.post('/orders/:id/redeem-points', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ paymentId: uuid, points: z.number().int().min(1).max(10_000_000) }), req.body);
    const [dup] = await db.select().from(payments).where(eq(payments.id, body.paymentId));
    if (dup) return getOrderDetail(db, a.orgId, branchId, id);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลนี้ชำระครบหรือปิดแล้ว');
      if (!o.customerId) throw unprocessable('ระบุสมาชิกก่อนใช้แต้ม', 'NO_CUSTOMER');
      const s = await orgSettings(tx, a.orgId);
      if (!s.loyalty.enabled || s.loyalty.pointValueSatang <= 0) throw unprocessable('ยังไม่ได้เปิดใช้ระบบแต้มสะสม', 'LOYALTY_DISABLED');
      const shift = await openShiftFor(tx, branchId, a.userId);
      if (!shift) throw unprocessable('กรุณาเปิดกะก่อนรับชำระเงิน', 'NO_OPEN_SHIFT');
      const { confirmed, pending } = await paidAmount(tx, id);
      const amount = body.points * s.loyalty.pointValueSatang;
      if (amount > o.grandTotalSatang - confirmed - pending) throw unprocessable('มูลค่าแต้มเกินยอดที่ต้องชำระ', 'OVERPAYMENT');
      await tx.insert(payments).values({ id: body.paymentId, organizationId: a.orgId, branchId, orderId: id, shiftId: shift.id, method: 'POINTS', status: 'CONFIRMED', amountSatang: amount, reference: `${body.points} แต้ม`, createdBy: a.userId, confirmedBy: a.userId, confirmedAt: new Date() });
      await postPoints(tx, { orgId: a.orgId, customerId: o.customerId, type: 'REDEEM', points: -body.points, orderId: id, paymentId: body.paymentId, reason: `ใช้แต้ม บิล #${o.orderNo}`, idempotencyKey: `REDEEM:${body.paymentId}`, createdBy: a.userId });
      await audit(tx, a, { action: 'loyalty.redeem', targetType: 'order', targetId: id, data: { points: body.points, amount } }, req.ip);
      await settleOrder(tx, bus, a, id, shift.id);
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  // ---------- Promotions admin ----------
  app.get('/promotions', async (req) => {
    const a = requirePerm(req, 'promotion.manage');
    const list = await db.select().from(promotions).where(eq(promotions.organizationId, a.orgId)).orderBy(desc(promotions.createdAt));
    const usage = list.length
      ? await db
          .select({ promotionId: promotionRedemptions.promotionId, n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${promotionRedemptions.discountSatang}),0)::bigint` })
          .from(promotionRedemptions)
          .where(and(inArray(promotionRedemptions.promotionId, list.map((p) => p.id)), eq(promotionRedemptions.status, 'APPLIED')))
          .groupBy(promotionRedemptions.promotionId)
      : [];
    return { promotions: list.map((p) => ({ ...p, used: usage.find((u) => u.promotionId === p.id)?.n ?? 0, discountGivenSatang: Number(usage.find((u) => u.promotionId === p.id)?.amount ?? 0) })) };
  });

  app.post('/promotions', async (req) => {
    const a = requirePerm(req, 'promotion.manage');
    const body = parse(promotionBody, req.body);
    validatePromo(body);
    const [p] = await db
      .insert(promotions)
      .values({ organizationId: a.orgId, ...body, startsAt: body.startsAt ? new Date(body.startsAt) : null, endsAt: body.endsAt ? new Date(body.endsAt) : null, createdBy: a.userId })
      .returning();
    await audit(db, a, { action: 'promotion.create', targetType: 'promotion', targetId: p.id, data: body, branchId: null }, req.ip);
    return p;
  });

  app.put('/promotions/:id', async (req) => {
    const a = requirePerm(req, 'promotion.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(promotionBody.extend({ archived: z.boolean().optional() }), req.body);
    validatePromo(body);
    const { archived, ...cols } = body;
    const [p] = await db
      .update(promotions)
      .set({ ...cols, startsAt: body.startsAt ? new Date(body.startsAt) : null, endsAt: body.endsAt ? new Date(body.endsAt) : null, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
      .where(and(eq(promotions.id, id), eq(promotions.organizationId, a.orgId)))
      .returning();
    if (!p) throw notFound('โปรโมชัน');
    await audit(db, a, { action: 'promotion.update', targetType: 'promotion', targetId: id, data: body, branchId: null }, req.ip);
    return p;
  });

  /** Generate coupon codes (single- or multi-use) for a promotion. */
  app.post('/promotions/:id/coupons', async (req) => {
    const a = requirePerm(req, 'promotion.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ count: z.number().int().min(1).max(500).default(1), maxUses: z.number().int().min(1).max(100000).default(1), prefix: z.string().regex(/^[A-Z0-9]{0,8}$/).default(''), code: z.string().regex(/^[A-Z0-9-]{3,40}$/).optional(), expiresAt: z.string().datetime({ offset: true }).optional(), customerId: uuid.optional() }),
      req.body,
    );
    const [p] = await db.select().from(promotions).where(and(eq(promotions.id, id), eq(promotions.organizationId, a.orgId)));
    if (!p) throw notFound('โปรโมชัน');
    if (body.code && body.count > 1) throw badRequest('ระบุรหัสเองได้ครั้งละ 1 คูปอง');
    if (body.customerId) {
      const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, body.customerId), eq(customers.organizationId, a.orgId)));
      if (!c) throw badRequest('ลูกค้าไม่ถูกต้อง');
    }
    const codes = body.code ? [body.code] : Array.from({ length: body.count }, () => `${body.prefix}${randomBytes(5).toString('hex').toUpperCase()}`);
    try {
      const rows = await db
        .insert(coupons)
        .values(codes.map((code) => ({ organizationId: a.orgId, promotionId: id, code, maxUses: body.maxUses, customerId: body.customerId ?? null, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null })))
        .returning();
      await audit(db, a, { action: 'coupon.generate', targetType: 'promotion', targetId: id, data: { count: rows.length, maxUses: body.maxUses }, branchId: null }, req.ip);
      return { coupons: rows };
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('รหัสคูปองซ้ำ');
      throw e;
    }
  });

  app.get('/promotions/:id/coupons', async (req) => {
    const a = requirePerm(req, 'promotion.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return { coupons: await db.select().from(coupons).where(and(eq(coupons.promotionId, id), eq(coupons.organizationId, a.orgId))).orderBy(desc(coupons.createdAt)).limit(1000) };
  });

  // ---------- Loyalty programme settings & jobs ----------
  app.get('/settings/org', async (req) => {
    const a = requireAnyPerm(req, 'settings.manage', 'promotion.manage', 'org.manage');
    const [o] = await db.select().from(organizations).where(eq(organizations.id, a.orgId));
    return { name: o.name, settings: await orgSettings(db, a.orgId) };
  });

  app.put('/settings/org', async (req) => {
    const a = requireAnyPerm(req, 'settings.manage', 'org.manage');
    // Organisation-wide settings require the permission at org level, not just in one branch.
    const orgWide = await resolvePermissions(db, a.userId, null);
    if (!orgWide.permissions.has('settings.manage') && !orgWide.permissions.has('org.manage')) throw forbidden('ต้องมีสิทธิ์ระดับองค์กร');
    const body = parse(z.object({ name: nonEmpty(100), settings: orgSettingsSchema }), req.body);
    await db.update(organizations).set({ name: body.name, settings: body.settings }).where(eq(organizations.id, a.orgId));
    await audit(db, a, { action: 'settings.org_update', targetType: 'organization', targetId: a.orgId, data: body, branchId: null }, req.ip);
    return { ok: true };
  });

  app.post('/crm/expire-points', async (req) => {
    const a = requirePerm(req, 'loyalty.adjust');
    const s = await orgSettings(db, a.orgId);
    if (!s.loyalty.expiryMonths) return { expired: 0, customers: 0 };
    const cs = await db.selectDistinct({ id: loyaltyTransactions.customerId }).from(loyaltyTransactions).where(and(eq(loyaltyTransactions.organizationId, a.orgId), sql`${loyaltyTransactions.expiresAt} <= now()`));
    let total = 0;
    for (const c of cs) total += await db.transaction((tx) => expirePoints(tx, a.orgId, c.id));
    await audit(db, a, { action: 'loyalty.expire_run', data: { total, customers: cs.length }, branchId: null }, req.ip);
    return { expired: total, customers: cs.length };
  });

  /** Issue birthday coupons for this month's birthdays (only when a birthday promotion is configured). */
  app.post('/crm/birthday-coupons', async (req) => {
    const a = requirePerm(req, 'promotion.manage');
    const s = await orgSettings(db, a.orgId);
    const promoId = s.loyalty.birthdayCouponPromotionId;
    if (!promoId) throw unprocessable('ยังไม่ได้ตั้งค่าโปรโมชันวันเกิดในการตั้งค่าสมาชิก', 'NOT_CONFIGURED');
    const month = new Date().getMonth() + 1;
    const year = new Date().getFullYear();
    const born = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.organizationId, a.orgId), isNull(customers.anonymizedAt), sql`extract(month from ${customers.birthDate}) = ${month}`));
    let issued = 0;
    for (const c of born) {
      const [has] = await db.select({ id: coupons.id }).from(coupons).where(and(eq(coupons.customerId, c.id), eq(coupons.promotionId, promoId), sql`extract(year from ${coupons.createdAt}) = ${year}`));
      if (has) continue;
      await db.insert(coupons).values({ organizationId: a.orgId, promotionId: promoId, code: `BD${randomBytes(4).toString('hex').toUpperCase()}`, maxUses: 1, customerId: c.id, expiresAt: new Date(year, month, 1) });
      issued++;
    }
    await audit(db, a, { action: 'coupon.birthday_issue', data: { issued, month }, branchId: null }, req.ip);
    return { issued, note: 'คูปองถูกสร้างในระบบแล้ว การส่งผ่าน LINE/SMS ต้องตั้งค่าช่องทางก่อน (ปิดอยู่)' };
  });

  /** Marketing audience preview: only customers who consented. Delivery stays disabled until a channel is configured. */
  app.get('/crm/audience', async (req) => {
    const a = requirePerm(req, 'customer.view');
    const [{ consented, total }] = await db
      .select({ consented: sql<number>`count(*) filter (where ${customers.consentMarketing})::int`, total: sql<number>`count(*)::int` })
      .from(customers)
      .where(and(eq(customers.organizationId, a.orgId), isNull(customers.anonymizedAt)));
    return { consented, total, deliveryChannels: { line: false, sms: false, email: false } };
  });

}
