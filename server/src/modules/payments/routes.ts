import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { applyBps } from '@shared/money';
import { promptPayPayload } from '@shared/promptpay';
import { resolveBranchSettings } from '@shared/settings';
import { approvalSchema, reasonSchema, satang, uuid } from '@shared/validation';
import { branches, cashMovements, orderDiscounts, orderItems, orders, payments, refunds, shifts, taxInvoices, users } from '../../db/schema';
import { PAYMENT_METHODS } from '../../db/schema/payments';
import { audit } from '../../lib/audit';
import { authorizeSensitive, requireAnyPerm, requireBranch, requirePerm } from '../../lib/auth';
import { badRequest, conflict, isUniqueViolation, notFound, parse, unprocessable } from '../../lib/errors';
import { businessDate } from '../../lib/time';
import { branchSettings } from '../menu/service';
import { orderHooks, runOrderHook } from '../orders/hooks';
import { getOrderDetail, lockOrder, recalcOrder } from '../orders/service';
import { assertMethodEnabled, assertNoMoney, buildShiftReport, nextDocNo, openShiftFor, paidAmount, settleOrder } from './service';

/** Methods confirmed by the cashier at the till (cash in hand, EDC slip, voucher). Others need explicit confirmation. */
const IMMEDIATE = new Set(['CASH', 'CARD', 'EWALLET', 'VOUCHER']);

export default async function paymentRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;
  const emit = (orgId: string, branchId: string, orderId: string) => bus.publish({ type: 'order.updated', organizationId: orgId, branchId, payload: { orderId } });

  // ---------- Discounts ----------
  app.post('/orders/:id/discounts', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        scope: z.enum(['BILL', 'ITEM']),
        orderItemId: uuid.optional(),
        type: z.enum(['PERCENT', 'AMOUNT']),
        value: z.number().int().min(1),
        reason: reasonSchema,
        approval: approvalSchema,
      }),
      req.body,
    );
    if (body.type === 'PERCENT' && body.value > 10_000) throw badRequest('ส่วนลดเกิน 100%');
    if (body.scope === 'ITEM' && !body.orderItemId) throw badRequest('เลือกรายการที่จะลด');
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      await assertNoMoney(tx, o.id, 'มีการชำระหรือรอยืนยันการชำระแล้ว ให้ส่วนลดเพิ่มไม่ได้');
      let base = o.subtotalSatang - o.discountSatang;
      if (body.scope === 'ITEM') {
        const [it] = await tx.select().from(orderItems).where(and(eq(orderItems.id, body.orderItemId!), eq(orderItems.orderId, id)));
        if (!it || it.status === 'CANCELLED') throw badRequest('รายการไม่ถูกต้อง');
        base = it.unitPriceSatang * it.qty;
      }
      // Discount ceiling: beyond maxDiscountBps of the base needs bill.discount_override (SPEC §2).
      const s = await branchSettings(tx, branchId);
      const amount = body.type === 'PERCENT' ? applyBps(base, body.value) : body.value;
      const overCeiling = amount > applyBps(base, s.maxDiscountBps);
      const approver = await authorizeSensitive(tx, a, overCeiling ? 'bill.discount_override' : 'bill.discount', body.approval);
      const [d] = await tx
        .insert(orderDiscounts)
        .values({ orderId: id, organizationId: a.orgId, branchId, scope: body.scope, orderItemId: body.orderItemId ?? null, type: body.type, value: body.value, reason: body.reason, createdBy: a.userId, approvedBy: approver })
        .returning();
      const after = await recalcOrder(tx, id);
      await audit(
        tx,
        a,
        { action: 'bill.discount', targetType: 'order', targetId: id, reason: body.reason, approverUserId: approver, data: { discountId: d.id, scope: body.scope, type: body.type, value: body.value, totalBefore: o.grandTotalSatang, totalAfter: after.grandTotalSatang } },
        req.ip,
      );
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  app.delete('/discounts/:id', async (req) => {
    const a = requirePerm(req, 'bill.discount');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [d] = await db.select().from(orderDiscounts).where(and(eq(orderDiscounts.id, id), eq(orderDiscounts.branchId, branchId)));
    if (!d) throw notFound('ส่วนลด');
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, d.orderId);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('แก้ไขส่วนลดไม่ได้แล้ว');
      await assertNoMoney(tx, o.id, 'มีการชำระหรือรอยืนยันการชำระแล้ว แก้ไขส่วนลดไม่ได้');
      await tx.update(orderDiscounts).set({ removedAt: new Date(), removedBy: a.userId }).where(eq(orderDiscounts.id, id));
      for (const h of orderHooks.discountRemoved) await h({ db: tx, actor: a, bus }, id);
      await recalcOrder(tx, d.orderId);
      await audit(tx, a, { action: 'bill.discount_removed', targetType: 'order', targetId: d.orderId, data: { discountId: id } }, req.ip);
    });
    emit(a.orgId, branchId, d.orderId);
    return getOrderDetail(db, a.orgId, branchId, d.orderId);
  });

  // ---------- Payments ----------
  app.post('/orders/:id/payments', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        id: uuid,
        method: z.enum(PAYMENT_METHODS),
        amountSatang: satang.min(1),
        tenderedSatang: satang.optional(),
        reference: z.string().trim().max(60).optional(),
        /** Set when the POS recorded this cash payment while offline and is syncing it now. */
        offlineRecordedAt: z.string().datetime({ offset: true }).optional(),
      }),
      req.body,
    );
    if (body.offlineRecordedAt && body.method !== 'CASH') throw badRequest('รับชำระแบบออฟไลน์ได้เฉพาะเงินสด');
    // Re-validate the bill (promotions etc.) in a separate, committed step: if anything changed the
    // cashier must see the new total before taking money.
    const [prior] = await db.select({ id: payments.id }).from(payments).where(eq(payments.id, body.id));
    if (!prior) {
      const changes = await db.transaction(async (tx) => {
        const o = await lockOrder(tx, a.orgId, branchId, id);
        if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) return [];
        const out: string[] = [];
        for (const h of orderHooks.beforePayment) out.push(...(await h({ db: tx, actor: a, bus }, o)));
        return out;
      });
      if (changes.length) {
        emit(a.orgId, branchId, id);
        throw conflict(`ยอดบิลเปลี่ยน: ${changes.join(', ')} — ตรวจยอดใหม่ก่อนรับเงิน`, 'PROMOTIONS_CHANGED');
      }
    }
    const result = await db.transaction(async (tx) => {
      // Idempotent retry: same payment id returns the existing record.
      const [dup] = await tx.select().from(payments).where(eq(payments.id, body.id));
      if (dup) {
        if (dup.orderId !== id) throw conflict('รหัสการชำระชนกับบิลอื่น');
        return { replay: true };
      }
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลนี้ชำระครบหรือปิดแล้ว', 'ORDER_NOT_PAYABLE');
      const s = await branchSettings(tx, branchId);
      assertMethodEnabled(s.enabledPaymentMethods, body.method);
      if (['POINTS', 'STORED_VALUE'].includes(body.method)) throw badRequest('ใช้แต้ม/เงินในบัตรผ่านหน้าสมาชิก (Prompt 12)');
      const shift = await openShiftFor(tx, branchId, a.userId);
      if (!shift) throw unprocessable('กรุณาเปิดกะก่อนรับชำระเงิน', 'NO_OPEN_SHIFT');
      const { confirmed, pending } = await paidAmount(tx, id);
      const remaining = o.grandTotalSatang - confirmed - pending;
      if (remaining <= 0) throw conflict('บิลนี้ไม่มียอดค้างชำระ (อาจมีรายการรอยืนยัน)', 'NOTHING_DUE');
      if (body.amountSatang > remaining) throw unprocessable(`ยอดเกินกว่าที่ต้องชำระ (${(remaining / 100).toFixed(2)} บาท)`, 'OVERPAYMENT');
      let change = 0;
      if (body.method === 'CASH') {
        const tendered = body.tenderedSatang ?? body.amountSatang;
        if (tendered < body.amountSatang) throw badRequest('รับเงินมาน้อยกว่ายอดที่ชำระ');
        change = tendered - body.amountSatang;
      } else if (body.tenderedSatang !== undefined) throw badRequest('ระบุเงินที่รับมาได้เฉพาะเงินสด');
      if (['CARD', 'TRANSFER'].includes(body.method) && !body.reference) throw badRequest('กรุณาระบุเลขอ้างอิง (Approval code / เลขที่สลิป)');
      const immediate = IMMEDIATE.has(body.method);
      const [p] = await tx
        .insert(payments)
        .values({
          id: body.id,
          organizationId: a.orgId,
          branchId,
          orderId: id,
          shiftId: shift.id,
          method: body.method,
          status: immediate ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
          amountSatang: body.amountSatang,
          tenderedSatang: body.method === 'CASH' ? (body.tenderedSatang ?? body.amountSatang) : null,
          changeSatang: change,
          reference: body.reference ?? null,
          createdBy: a.userId,
          confirmedBy: immediate ? a.userId : null,
          confirmedAt: immediate ? new Date() : null,
          offlineRecordedAt: body.offlineRecordedAt ? new Date(body.offlineRecordedAt) : null,
        })
        .returning();
      await audit(tx, a, { action: 'payment.create', targetType: 'payment', targetId: p.id, data: { orderId: id, method: p.method, amount: p.amountSatang, status: p.status } }, req.ip);
      if (immediate) await settleOrder(tx, bus, a, id, shift.id);
      return { replay: false };
    });
    if (!result.replay) emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  /** Confirm a transfer/PromptPay after checking the bank app or statement. */
  app.post('/payments/:id/confirm', async (req) => {
    const a = requirePerm(req, 'payment.confirm_transfer');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ reference: z.string().trim().min(1, 'ระบุเลขอ้างอิงการโอน').max(60) }), req.body);
    const [p0] = await db.select().from(payments).where(and(eq(payments.id, id), eq(payments.branchId, branchId)));
    if (!p0) throw notFound('การชำระเงิน');
    await db.transaction(async (tx) => {
      await lockOrder(tx, a.orgId, branchId, p0.orderId);
      const [p] = await tx.select().from(payments).where(eq(payments.id, id));
      if (p.status === 'CONFIRMED') return;
      if (p.status !== 'PENDING_CONFIRMATION') throw conflict('รายการนี้ถูกยกเลิกแล้ว');
      await tx.update(payments).set({ status: 'CONFIRMED', confirmedBy: a.userId, confirmedAt: new Date(), reference: body.reference }).where(eq(payments.id, id));
      await audit(tx, a, { action: 'payment.confirm', targetType: 'payment', targetId: id, data: { orderId: p.orderId, method: p.method, amount: p.amountSatang, reference: body.reference } }, req.ip);
      await settleOrder(tx, bus, a, p.orderId, p.shiftId);
    });
    emit(a.orgId, branchId, p0.orderId);
    return getOrderDetail(db, a.orgId, branchId, p0.orderId);
  });

  /** Drop a payment that was never confirmed (customer changed method, QR expired…). */
  app.post('/payments/:id/cancel', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [p] = await db.select().from(payments).where(and(eq(payments.id, id), eq(payments.branchId, branchId)));
    if (!p) throw notFound('การชำระเงิน');
    await db.transaction(async (tx) => {
      await lockOrder(tx, a.orgId, branchId, p.orderId);
      const [cur] = await tx.select().from(payments).where(eq(payments.id, id));
      if (cur.status !== 'PENDING_CONFIRMATION') throw conflict('ยกเลิกได้เฉพาะรายการที่ยังไม่ยืนยัน ถ้ายืนยันแล้วให้ใช้การคืนเงิน');
      await tx.update(payments).set({ status: 'VOIDED', voidedAt: new Date(), voidedBy: a.userId }).where(eq(payments.id, id));
      await audit(tx, a, { action: 'payment.cancel', targetType: 'payment', targetId: id, data: { orderId: p.orderId, amount: p.amountSatang } }, req.ip);
    });
    emit(a.orgId, branchId, p.orderId);
    return getOrderDetail(db, a.orgId, branchId, p.orderId);
  });

  /** Refund (part of) a confirmed payment. Needs payment.refund or manager PIN, plus a reason. */
  app.post('/payments/:id/refund', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ amountSatang: satang.min(1), reason: reasonSchema, approval: approvalSchema }), req.body);
    const [p0] = await db.select().from(payments).where(and(eq(payments.id, id), eq(payments.branchId, branchId)));
    if (!p0) throw notFound('การชำระเงิน');
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, p0.orderId);
      const [p] = await tx.select().from(payments).where(eq(payments.id, id));
      if (p.status !== 'CONFIRMED') throw conflict('คืนเงินได้เฉพาะรายการที่ยืนยันแล้ว');
      if (body.amountSatang > p.amountSatang - p.refundedSatang) throw unprocessable('ยอดคืนเกินยอดที่ชำระมา', 'REFUND_EXCEEDS');
      const approver = await authorizeSensitive(tx, a, 'payment.refund', body.approval);
      const shift = await openShiftFor(tx, branchId, a.userId);
      if (p.method === 'CASH' && !shift) throw unprocessable('คืนเงินสดต้องเปิดกะก่อน', 'NO_OPEN_SHIFT');
      await tx.insert(refunds).values({ organizationId: a.orgId, branchId, paymentId: id, orderId: o.id, shiftId: shift?.id ?? null, method: p.method, amountSatang: body.amountSatang, reason: body.reason, createdBy: a.userId, approvedBy: approver });
      await tx.update(payments).set({ refundedSatang: p.refundedSatang + body.amountSatang }).where(eq(payments.id, id));
      for (const h of orderHooks.paymentRefunded) await h({ db: tx, actor: a, bus }, p, body.amountSatang);
      const { confirmed } = await paidAmount(tx, o.id);
      // Fully refunded paid bill goes back to OPEN so it can be corrected or voided (state machine PAID → OPEN).
      const reopen = o.status === 'PAID' && confirmed === 0;
      await tx
        .update(orders)
        .set({ paidSatang: confirmed, ...(reopen ? { status: 'OPEN' as const, paidAt: null } : {}), version: sql`${orders.version} + 1` })
        .where(eq(orders.id, o.id));
      if (reopen) await runOrderHook(orderHooks.orderReopened, { db: tx, actor: a, bus }, { ...o, status: 'OPEN' });
      await audit(
        tx,
        a,
        { action: 'payment.refund', targetType: 'payment', targetId: id, reason: body.reason, approverUserId: approver, data: { orderId: o.id, orderNo: o.orderNo, method: p.method, amount: body.amountSatang, reopened: reopen } },
        req.ip,
      );
    });
    emit(a.orgId, branchId, p0.orderId);
    return getOrderDetail(db, a.orgId, branchId, p0.orderId);
  });

  /** Static PromptPay QR for the amount due (generated locally; does not confirm anything). */
  app.get('/orders/:id/promptpay', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { amount } = parse(z.object({ amount: z.coerce.number().int().min(1) }), req.query);
    const s = await branchSettings(db, branchId);
    if (!s.promptPayId) throw unprocessable('ยังไม่ได้ตั้งค่า PromptPay ID ในหน้าตั้งค่าร้าน', 'PROMPTPAY_NOT_CONFIGURED');
    const [o] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, id), eq(orders.branchId, branchId)));
    if (!o) throw notFound('บิล');
    const payload = promptPayPayload(s.promptPayId, amount);
    return { payload, dataUrl: await QRCode.toDataURL(payload, { margin: 1, width: 320 }) };
  });

  /** Close a zero-total bill (e.g. 100% comp) without a payment. */
  app.post('/orders/:id/settle-zero', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (o.grandTotalSatang !== 0) throw conflict('บิลนี้มียอดต้องชำระ');
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orderItems).where(and(eq(orderItems.orderId, id), sql`${orderItems.status} <> 'CANCELLED'`));
      if (n === 0) throw conflict('บิลว่าง ให้ Void แทน');
      const shift = await openShiftFor(tx, branchId, a.userId);
      await settleOrder(tx, bus, a, id, shift?.id ?? null);
      await audit(tx, a, { action: 'order.settle_zero', targetType: 'order', targetId: id }, req.ip);
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  // ---------- Receipts & tax invoices ----------
  app.get('/orders/:id/receipt', async (req) => {
    const a = requireAnyPerm(req, 'order.view', 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const order = await getOrderDetail(db, a.orgId, branchId, id);
    const [b] = await db.select().from(branches).where(eq(branches.id, branchId));
    const s = resolveBranchSettings(b.settings);
    const [cashier] = order.closedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, order.closedBy)) : [];
    const [inv] = await db.select().from(taxInvoices).where(and(eq(taxInvoices.orderId, id), sql`${taxInvoices.cancelledAt} is null`));
    return {
      seller: { name: b.name, address: b.address, phone: b.phone, taxId: b.taxId, header: s.receiptHeader, footer: s.receiptFooter },
      /** Abbreviated tax invoice only when the branch is VAT-registered (tax id + VAT enabled). */
      isTaxInvoice: !!b.taxId && s.vatMode !== 'NONE',
      cashier: cashier?.name ?? null,
      taxInvoice: inv ?? null,
      order,
    };
  });

  app.post('/orders/:id/tax-invoice', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        buyerName: z.string().trim().min(1).max(200),
        buyerTaxId: z.string().regex(/^\d{13}$/, 'เลขประจำตัวผู้เสียภาษี 13 หลัก'),
        buyerAddress: z.string().trim().min(5).max(500),
        buyerBranch: z.string().trim().max(50).optional(),
      }),
      req.body,
    );
    try {
      const inv = await db.transaction(async (tx) => {
        const o = await lockOrder(tx, a.orgId, branchId, id);
        if (!['PAID', 'CLOSED'].includes(o.status)) throw conflict('ออกใบกำกับภาษีเต็มรูปได้หลังชำระเงินครบ');
        const [b] = await tx.select().from(branches).where(eq(branches.id, branchId));
        if (!b.taxId) throw unprocessable('สาขายังไม่ได้ตั้งเลขประจำตัวผู้เสียภาษี', 'NOT_VAT_REGISTERED');
        const year = o.businessDate.slice(0, 4);
        const invoiceNo = `INV${b.code}${year}-${String(await nextDocNo(tx, branchId, 'TAX_INVOICE', year)).padStart(6, '0')}`;
        const [row] = await tx
          .insert(taxInvoices)
          .values({
            organizationId: a.orgId,
            branchId,
            orderId: id,
            invoiceNo,
            ...body,
            buyerBranch: body.buyerBranch ?? 'สำนักงานใหญ่',
            snapshot: { seller: { name: b.name, address: b.address, taxId: b.taxId }, receiptNo: o.receiptNo, subtotal: o.subtotalSatang, discount: o.discountSatang, service: o.serviceChargeSatang, vat: o.vatSatang, total: o.grandTotalSatang, pricing: o.pricing },
            issuedBy: a.userId,
          })
          .returning();
        await audit(tx, a, { action: 'tax_invoice.issue', targetType: 'order', targetId: id, data: { invoiceNo, buyerTaxId: body.buyerTaxId } }, req.ip);
        return row;
      });
      return inv;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('บิลนี้ออกใบกำกับภาษีเต็มรูปแล้ว');
      throw e;
    }
  });

  // ---------- Shifts & cash drawer ----------
  app.get('/shifts/current', async (req) => {
    const a = requireAnyPerm(req, 'shift.open', 'payment.take');
    const branchId = requireBranch(a);
    const s = await openShiftFor(db, branchId, a.userId);
    return { shift: s, report: s ? await buildShiftReport(db, s.id) : null };
  });

  app.post('/shifts/open', async (req) => {
    const a = requirePerm(req, 'shift.open');
    const branchId = requireBranch(a);
    const body = parse(z.object({ openingFloatSatang: satang }), req.body);
    const s = await branchSettings(db, branchId);
    try {
      const [shift] = await db
        .insert(shifts)
        .values({ organizationId: a.orgId, branchId, userId: a.userId, deviceId: a.deviceId, businessDate: businessDate(s.timezone), openingFloatSatang: body.openingFloatSatang })
        .returning();
      await audit(db, a, { action: 'shift.open', targetType: 'shift', targetId: shift.id, data: { openingFloat: body.openingFloatSatang } }, req.ip);
      return shift;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('คุณมีกะที่เปิดอยู่แล้ว');
      throw e;
    }
  });

  app.get('/shifts', async (req) => {
    const a = requireAnyPerm(req, 'shift.view_all', 'shift.open');
    const branchId = requireBranch(a);
    const q = parse(z.object({ date: z.string().optional() }), req.query);
    const all = a.permissions.has('shift.view_all');
    const rows = await db
      .select({ shift: shifts, cashier: users.name })
      .from(shifts)
      .leftJoin(users, eq(users.id, shifts.userId))
      .where(and(eq(shifts.branchId, branchId), q.date ? eq(shifts.businessDate, q.date) : undefined, all ? undefined : eq(shifts.userId, a.userId)))
      .orderBy(desc(shifts.openedAt))
      .limit(100);
    return { shifts: rows.map((r) => ({ ...r.shift, cashier: r.cashier, zReport: undefined })) };
  });

  const loadShift = async (a: { orgId: string; userId: string; permissions: Set<string> }, branchId: string, id: string) => {
    const [s] = await db.select().from(shifts).where(and(eq(shifts.id, id), eq(shifts.branchId, branchId), eq(shifts.organizationId, a.orgId)));
    if (!s) throw notFound('กะ');
    if (s.userId !== a.userId && !a.permissions.has('shift.view_all')) throw notFound('กะ');
    return s;
  };

  /** X-report (live) or the frozen Z-report of a closed shift. */
  app.get('/shifts/:id/report', async (req) => {
    const a = requireAnyPerm(req, 'shift.open', 'shift.view_all');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const s = await loadShift(a, branchId, id);
    return { kind: s.status === 'OPEN' ? 'X' : 'Z', report: s.status === 'CLOSED' && s.zReport ? s.zReport : await buildShiftReport(db, id) };
  });

  app.post('/shifts/:id/cash', async (req) => {
    const a = requirePerm(req, 'shift.open');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ type: z.enum(['PAY_IN', 'PAY_OUT', 'NO_SALE']), amountSatang: satang, reason: reasonSchema, approval: approvalSchema }), req.body);
    if (body.type !== 'NO_SALE' && body.amountSatang <= 0) throw badRequest('ระบุจำนวนเงิน');
    const s = await loadShift(a, branchId, id);
    if (s.status !== 'OPEN') throw conflict('กะนี้ปิดแล้ว');
    if (s.userId !== a.userId) throw conflict('ทำรายการลิ้นชักได้เฉพาะกะของตัวเอง');
    const approver = await authorizeSensitive(db, a, body.type === 'NO_SALE' ? 'cash.open_drawer' : 'cash.pay_in_out', body.approval);
    const [m] = await db
      .insert(cashMovements)
      .values({ shiftId: id, organizationId: a.orgId, branchId, type: body.type, amountSatang: body.type === 'NO_SALE' ? 0 : body.amountSatang, reason: body.reason, createdBy: a.userId, approvedBy: approver })
      .returning();
    await audit(db, a, { action: `cash.${body.type.toLowerCase()}`, targetType: 'shift', targetId: id, reason: body.reason, approverUserId: approver, data: { amount: m.amountSatang } }, req.ip);
    return m;
  });

  /** Close the shift: count cash, freeze the Z-report, record variance. */
  app.post('/shifts/:id/close', async (req) => {
    const a = requirePerm(req, 'shift.close');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ countedCashSatang: satang, countDetail: z.record(z.string(), z.number().int().min(0)).optional(), note: z.string().max(500).optional() }), req.body);
    const s = await loadShift(a, branchId, id);
    if (s.status !== 'OPEN') throw conflict('กะนี้ปิดแล้ว');
    if (s.userId !== a.userId && !a.permissions.has('shift.view_all')) throw conflict('ปิดได้เฉพาะกะของตัวเอง');
    const report = await db.transaction(async (tx) => {
      const pending = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.shiftId, id), eq(payments.status, 'PENDING_CONFIRMATION')));
      if (pending.length) throw conflict(`ยังมีการชำระรอยืนยัน ${pending.length} รายการ ยืนยันหรือยกเลิกก่อนปิดกะ`, 'PENDING_PAYMENTS');
      const r = await buildShiftReport(tx, id);
      const variance = body.countedCashSatang - r.expectedCashSatang;
      const z = { ...r, status: 'CLOSED', closedAt: new Date(), countedCashSatang: body.countedCashSatang, varianceSatang: variance };
      await tx
        .update(shifts)
        .set({ status: 'CLOSED', closedAt: new Date(), closedBy: a.userId, expectedCashSatang: r.expectedCashSatang, countedCashSatang: body.countedCashSatang, varianceSatang: variance, countDetail: body.countDetail, closeNote: body.note, zReport: z })
        .where(eq(shifts.id, id));
      // End of day: paid bills of this shift become CLOSED (SPEC §4.3).
      await tx.update(orders).set({ status: 'CLOSED', closedAt: new Date() }).where(and(eq(orders.shiftId, id), eq(orders.status, 'PAID')));
      await audit(tx, a, { action: 'shift.close', targetType: 'shift', targetId: id, data: { expected: r.expectedCashSatang, counted: body.countedCashSatang, variance } }, req.ip);
      return z;
    });
    return { kind: 'Z', report };
  });
}
