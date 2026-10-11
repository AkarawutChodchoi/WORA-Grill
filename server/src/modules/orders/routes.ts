import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { POS_CHANNELS, SALES_CHANNELS } from '@shared/states';
import { approvalSchema, dateString, reasonSchema, uuid } from '@shared/validation';
import { diningTables, orderDiscounts, orderItems, orders } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeSensitive, requireAnyPerm, requireBranch, requirePerm } from '../../lib/auth';
import { badRequest, conflict, parse } from '../../lib/errors';
import { loadBranchMenu, resolveLine } from '../menu/service';
import { refreshTableForOrder, releaseTable } from '../tables/service';
import { createOrder } from './create';
import { assertNoMoney } from '../payments/service';
import { orderHooks, runItemsHook, runOrderHook } from './hooks';
import { assertCancellable, assertEditable, assertOrderTransition, getOrderDetail, lockOrder, nextSeq, recalcOrder, sendItems } from './service';

const lineSchema = z.object({
  /** Client-generated id makes retries idempotent. */
  id: uuid,
  menuItemId: uuid,
  qty: z.number().int().min(1).max(99),
  modifiers: z.array(z.object({ modifierId: uuid, qty: z.number().int().min(1).max(20).optional() })).max(30).default([]),
  note: z.string().trim().max(200).optional(),
  course: z.number().int().min(1).max(5).optional(),
  held: z.boolean().default(false),
});

export default async function orderRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;
  const emit = (orgId: string, branchId: string, orderId: string, type: 'order.updated' | 'order.created' = 'order.updated') =>
    bus.publish({ type, organizationId: orgId, branchId, payload: { orderId } });

  /** Open a non-table bill (takeaway / own delivery / quick service). Dine-in bills are opened from a table. */
  app.post('/orders', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const body = parse(
      z.object({
        id: uuid.optional(),
        channel: z.enum(POS_CHANNELS as [string, ...string[]]),
        guestCount: z.number().int().min(1).max(100).default(1),
        customerName: z.string().trim().max(100).optional(),
        customerPhone: z.string().trim().max(30).optional(),
        note: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    if (body.channel === 'DINE_IN') throw badRequest('บิลทานที่ร้านให้เปิดจากผังโต๊ะ');
    const { order, created } = await db.transaction(async (tx) => {
      const r = await createOrder(tx, { ...body, orgId: a.orgId, branchId, openedBy: a.userId, source: 'POS' });
      if (r.created) await audit(tx, a, { action: 'order.open', targetType: 'order', targetId: r.order.id, data: { channel: body.channel, orderNo: r.order.orderNo } }, req.ip);
      return r;
    });
    if (created) emit(a.orgId, branchId, order.id, 'order.created');
    return order;
  });

  app.get('/orders', async (req) => {
    const a = requirePerm(req, 'order.view');
    const branchId = requireBranch(a);
    const q = parse(
      z.object({
        scope: z.enum(['active', 'today', 'date']).default('active'),
        date: dateString.optional(),
        channel: z.enum(SALES_CHANNELS).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    const conds: SQL[] = [eq(orders.branchId, branchId), eq(orders.organizationId, a.orgId)];
    if (q.scope === 'active') conds.push(inArray(orders.status, ['OPEN', 'BILL_REQUESTED']));
    if (q.scope === 'date' && q.date) conds.push(eq(orders.businessDate, q.date));
    if (q.scope === 'today') conds.push(sql`${orders.businessDate} = (select max(business_date) from order_counters where branch_id = ${branchId})`);
    if (q.channel) conds.push(eq(orders.channel, q.channel));
    const rows = await db
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        businessDate: orders.businessDate,
        channel: orders.channel,
        source: orders.source,
        status: orders.status,
        tableId: orders.tableId,
        tableName: diningTables.name,
        guestCount: orders.guestCount,
        customerName: orders.customerName,
        grandTotalSatang: orders.grandTotalSatang,
        paidSatang: orders.paidSatang,
        openedAt: orders.openedAt,
        closedAt: orders.closedAt,
        itemCount: sql<number>`(select count(*)::int from ${orderItems} oi where oi.order_id = ${orders.id} and oi.status <> 'CANCELLED')`,
        pendingCount: sql<number>`(select count(*)::int from ${orderItems} oi where oi.order_id = ${orders.id} and oi.status = 'PENDING')`,
      })
      .from(orders)
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(...conds))
      .orderBy(desc(orders.openedAt))
      .limit(q.limit);
    return { orders: rows };
  });

  app.get('/orders/:id', async (req) => {
    const a = requireAnyPerm(req, 'order.view', 'order.create');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return getOrderDetail(db, a.orgId, requireBranch(a), id);
  });

  app.patch('/orders/:id', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ guestCount: z.number().int().min(1).max(100).optional(), customerName: z.string().trim().max(100).nullable().optional(), customerPhone: z.string().trim().max(30).nullable().optional(), note: z.string().trim().max(300).nullable().optional() }),
      req.body,
    );
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      await tx.update(orders).set({ ...body, version: sql`${orders.version} + 1` }).where(eq(orders.id, id));
      await audit(tx, a, { action: 'order.update', targetType: 'order', targetId: id, data: body }, req.ip);
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  /** Add lines (saved as PENDING drafts). Prices/modifiers are validated against the live menu. */
  app.post('/orders/:id/items', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ items: z.array(lineSchema).min(1).max(100), send: z.boolean().default(false) }), req.body);
    if (new Set(body.items.map((i) => i.id)).size !== body.items.length) throw badRequest('รหัสรายการซ้ำกัน');
    const sent = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      // Idempotency: lines that already exist (a retried request) are skipped, but must belong to this order.
      const existing = await tx.select({ id: orderItems.id, orderId: orderItems.orderId }).from(orderItems).where(inArray(orderItems.id, body.items.map((i) => i.id)));
      if (existing.some((e) => e.orderId !== id)) throw conflict('รหัสรายการชนกับบิลอื่น');
      const fresh = body.items.filter((i) => !existing.some((e) => e.id === i.id));
      if (fresh.length) {
        assertEditable(o);
        const menu = await loadBranchMenu(tx, { orgId: a.orgId, branchId, channel: o.channel });
        let seq = await nextSeq(tx, id);
        const rows = fresh.map((l) => {
          const r = resolveLine(menu, l);
          return {
            id: l.id,
            orderId: id,
            organizationId: a.orgId,
            branchId,
            menuItemId: r.menuItemId,
            nameSnapshot: r.name,
            nameEnSnapshot: r.nameEn,
            basePriceSatang: r.basePriceSatang,
            unitPriceSatang: r.unitPriceSatang,
            qty: l.qty,
            modifiers: r.modifiers.map((m) => ({ modifierId: m.modifierId, groupName: m.groupName, name: m.name, qty: m.qty, priceDeltaSatang: m.priceDeltaSatang })),
            comboComponents: r.comboComponents,
            allergens: r.allergens,
            note: l.note || null,
            stationCode: r.stationCode,
            course: l.course ?? r.course,
            held: l.held,
            lineTotalSatang: r.unitPriceSatang * l.qty,
            seq: seq++,
            source: a.sessionKind === 'PIN' ? 'WAITER' : 'POS',
            createdBy: a.userId,
          };
        });
        await tx.insert(orderItems).values(rows).onConflictDoNothing();
        await recalcOrder(tx, id);
        await audit(tx, a, { action: 'order.items_added', targetType: 'order', targetId: id, data: { items: rows.map((r) => ({ id: r.id, name: r.nameSnapshot, qty: r.qty, unit: r.unitPriceSatang })) } }, req.ip);
      }
      if (!body.send) return [];
      if (!a.permissions.has('order.send')) return [];
      const s = await sendItems(tx, bus, o, { itemIds: body.items.filter((i) => !i.held).map((i) => i.id) });
      await runItemsHook(orderHooks.itemsSent, { db: tx, actor: a, bus }, o, s);
      return s;
    });
    if (sent.length) await db.transaction((tx) => refreshTableForOrder(tx, bus, id));
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  /** Edit a draft (PENDING) line. */
  app.patch('/order-items/:id', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ qty: z.number().int().min(1).max(99).optional(), note: z.string().trim().max(200).nullable().optional(), course: z.number().int().min(1).max(5).optional(), held: z.boolean().optional() }), req.body);
    const [it] = await db.select().from(orderItems).where(and(eq(orderItems.id, id), eq(orderItems.branchId, branchId)));
    if (!it) throw badRequest('ไม่พบรายการ');
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, it.orderId);
      assertEditable(o);
      const [cur] = await tx.select().from(orderItems).where(eq(orderItems.id, id));
      if (cur.status !== 'PENDING') throw conflict('รายการส่งครัวแล้ว แก้ไขไม่ได้ ให้ยกเลิกแล้วสั่งใหม่');
      await tx
        .update(orderItems)
        .set({ ...body, ...(body.qty ? { lineTotalSatang: cur.unitPriceSatang * body.qty } : {}) })
        .where(eq(orderItems.id, id));
      await recalcOrder(tx, o.id);
    });
    emit(a.orgId, branchId, it.orderId);
    return getOrderDetail(db, a.orgId, branchId, it.orderId);
  });

  /**
   * Cancel a line. Drafts can be removed freely; lines already sent to the kitchen need a reason and
   * order.cancel_item (or a manager PIN approval).
   */
  app.post('/order-items/:id/cancel', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ reason: reasonSchema.optional(), approval: approvalSchema }), req.body);
    const [it] = await db.select().from(orderItems).where(and(eq(orderItems.id, id), eq(orderItems.branchId, branchId)));
    if (!it) throw badRequest('ไม่พบรายการ');
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, it.orderId);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      const [cur] = await tx.select().from(orderItems).where(eq(orderItems.id, id));
      assertCancellable(cur);
      let approver: string | null = null;
      const reason = body.reason ?? (cur.status === 'PENDING' ? 'ลบก่อนส่งครัว' : undefined);
      if (cur.status !== 'PENDING') {
        if (!body.reason) throw badRequest('ต้องระบุเหตุผลในการยกเลิกรายการที่ส่งครัวแล้ว');
        approver = await authorizeSensitive(tx, a, 'order.cancel_item', body.approval);
      }
      await tx.update(orderItems).set({ status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: reason, cancelledBy: a.userId }).where(eq(orderItems.id, id));
      await tx.update(orderDiscounts).set({ removedAt: new Date(), removedBy: a.userId }).where(eq(orderDiscounts.orderItemId, id));
      await recalcOrder(tx, o.id);
      if (cur.status !== 'PENDING') await runItemsHook(orderHooks.itemsCancelled, { db: tx, actor: a, bus }, o, [cur]);
      await audit(
        tx,
        a,
        { action: cur.status === 'PENDING' ? 'order.item_removed' : 'order.item_cancelled', targetType: 'order_item', targetId: id, reason, approverUserId: approver, data: { orderId: o.id, name: cur.nameSnapshot, qty: cur.qty, statusBefore: cur.status, amount: cur.lineTotalSatang } },
        req.ip,
      );
      if (cur.status !== 'PENDING')
        bus.publish({ type: 'order_item.status_changed', organizationId: a.orgId, branchId, payload: { orderId: o.id, itemId: id, status: 'CANCELLED' } });
      await refreshTableForOrder(tx, bus, o.id);
    });
    emit(a.orgId, branchId, it.orderId);
    return getOrderDetail(db, a.orgId, branchId, it.orderId);
  });

  /** Send drafts to the kitchen (held courses stay back unless listed). */
  app.post('/orders/:id/send', async (req) => {
    const a = requirePerm(req, 'order.send');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ itemIds: z.array(uuid).max(200).optional(), course: z.number().int().min(1).max(5).optional(), includeHeld: z.boolean().default(false) }), req.body ?? {});
    const sent = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      const s = await sendItems(tx, bus, o, body);
      await runItemsHook(orderHooks.itemsSent, { db: tx, actor: a, bus }, o, s);
      if (s.length) {
        await audit(tx, a, { action: body.includeHeld || body.course ? 'order.fire' : 'order.send', targetType: 'order', targetId: id, data: { items: s.map((i) => ({ id: i.id, name: i.nameSnapshot, qty: i.qty })) } }, req.ip);
        await refreshTableForOrder(tx, bus, id);
      }
      return s;
    });
    emit(a.orgId, branchId, id);
    return { sent: sent.length, order: await getOrderDetail(db, a.orgId, branchId, id) };
  });

  app.post('/orders/:id/request-bill', async (req) => {
    const a = requirePerm(req, 'order.request_bill');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (o.status === 'BILL_REQUESTED') return;
      assertOrderTransition(o, 'BILL_REQUESTED');
      await tx.update(orders).set({ status: 'BILL_REQUESTED', billRequestedAt: new Date(), version: sql`${orders.version} + 1` }).where(eq(orders.id, id));
      await audit(tx, a, { action: 'order.bill_requested', targetType: 'order', targetId: id }, req.ip);
      await refreshTableForOrder(tx, bus, id);
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  /** Back to OPEN to add more items after a bill was requested. */
  app.post('/orders/:id/reopen', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (o.status === 'OPEN') return;
      if (o.status !== 'BILL_REQUESTED') throw conflict('เปิดบิลนี้กลับมาแก้ไขไม่ได้ (ชำระแล้ว/ปิดแล้ว ต้องคืนเงินก่อน)');
      await tx.update(orders).set({ status: 'OPEN', billRequestedAt: null, version: sql`${orders.version} + 1` }).where(eq(orders.id, id));
      await audit(tx, a, { action: 'order.reopened', targetType: 'order', targetId: id }, req.ip);
      await refreshTableForOrder(tx, bus, id);
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  /** Void a whole bill (no payments allowed). Requires order.void or a manager PIN, plus a reason. */
  app.post('/orders/:id/void', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ reason: reasonSchema, approval: approvalSchema }), req.body);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      assertOrderTransition(o, 'VOIDED');
      await assertNoMoney(tx, o.id);
      const approver = await authorizeSensitive(tx, a, 'order.void', body.approval);
      const live = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, id), sql`${orderItems.status} <> 'CANCELLED'`));
      const sentBefore = live.filter((i) => i.status !== 'PENDING');
      await tx
        .update(orderItems)
        .set({ status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: `Void: ${body.reason}`, cancelledBy: a.userId })
        .where(and(eq(orderItems.orderId, id), sql`${orderItems.status} <> 'CANCELLED'`));
      await tx
        .update(orders)
        .set({ status: 'VOIDED', voidedAt: new Date(), voidedBy: a.userId, voidReason: body.reason, version: sql`${orders.version} + 1` })
        .where(eq(orders.id, id));
      const after = await recalcOrder(tx, id);
      await runItemsHook(orderHooks.itemsCancelled, { db: tx, actor: a, bus }, after, sentBefore);
      await runOrderHook(orderHooks.orderVoided, { db: tx, actor: a, bus }, after);
      if (o.tableId) await releaseTable(tx, bus, o.tableId, sentBefore.length ? 'CLEANING' : 'AVAILABLE');
      await audit(tx, a, { action: 'order.void', targetType: 'order', targetId: id, reason: body.reason, approverUserId: approver, data: { orderNo: o.orderNo, totalBefore: o.grandTotalSatang, items: live.length } }, req.ip);
      for (const i of sentBefore) bus.publish({ type: 'order_item.status_changed', organizationId: a.orgId, branchId, payload: { orderId: id, itemId: i.id, status: 'CANCELLED' } });
    });
    emit(a.orgId, branchId, id);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  /** Merge another open bill (e.g. another table) into this one (SPEC §3.1 รวมบิลข้ามโต๊ะ). */
  app.post('/orders/:id/merge', async (req) => {
    const a = requirePerm(req, 'bill.split');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { fromOrderId } = parse(z.object({ fromOrderId: uuid }), req.body);
    if (fromOrderId === id) throw badRequest('เลือกบิลอื่น');
    await db.transaction(async (tx) => {
      const [first, second] = [id, fromOrderId].sort();
      await lockOrder(tx, a.orgId, branchId, first);
      await lockOrder(tx, a.orgId, branchId, second);
      const target = await lockOrder(tx, a.orgId, branchId, id);
      const source = await lockOrder(tx, a.orgId, branchId, fromOrderId);
      for (const o of [target, source]) if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict(`บิล #${o.orderNo} ปิดแล้ว`);
      await assertNoMoney(tx, source.id);
      await assertNoMoney(tx, target.id);
      let seq = await nextSeq(tx, id);
      const moving = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, fromOrderId));
      for (const m of moving) await tx.update(orderItems).set({ orderId: id, seq: seq++ }).where(eq(orderItems.id, m.id));
      await tx.update(orderDiscounts).set({ orderId: id }).where(and(eq(orderDiscounts.orderId, fromOrderId), eq(orderDiscounts.scope, 'ITEM')));
      // Bill-level discounts of the source no longer apply to the combined bill.
      await tx.update(orderDiscounts).set({ removedAt: new Date(), removedBy: a.userId }).where(and(eq(orderDiscounts.orderId, fromOrderId), eq(orderDiscounts.scope, 'BILL')));
      await tx
        .update(orders)
        .set({ status: 'CLOSED', closedAt: new Date(), closedBy: a.userId, mergedIntoOrderId: id, guestCount: source.guestCount, version: sql`${orders.version} + 1` })
        .where(eq(orders.id, fromOrderId));
      await tx.update(orders).set({ guestCount: target.guestCount + source.guestCount, status: 'OPEN' }).where(eq(orders.id, id));
      await recalcOrder(tx, fromOrderId);
      await recalcOrder(tx, id);
      if (source.tableId) await releaseTable(tx, bus, source.tableId, 'CLEANING');
      await refreshTableForOrder(tx, bus, id);
      await audit(tx, a, { action: 'order.merge', targetType: 'order', targetId: id, data: { from: source.orderNo, into: target.orderNo, items: moving.length } }, req.ip);
    });
    emit(a.orgId, branchId, id);
    emit(a.orgId, branchId, fromOrderId);
    return getOrderDetail(db, a.orgId, branchId, id);
  });

  /** Split selected lines (optionally partial quantities) into a new bill paid separately. */
  app.post('/orders/:id/split', async (req) => {
    const a = requirePerm(req, 'bill.split');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ newOrderId: uuid.optional(), lines: z.array(z.object({ itemId: uuid, qty: z.number().int().min(1).max(99) })).min(1).max(100) }), req.body);
    const newId = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      await assertNoMoney(tx, o.id, 'แยกบิลที่มีการชำระหรือรอยืนยันการชำระไม่ได้ ใช้การชำระแบบแบ่งยอดแทน');
      // A client-supplied id may only replay this same split, never point at another existing bill.
      if (body.newOrderId) {
        const [existing] = await tx.select({ id: orders.id, splitFromOrderId: orders.splitFromOrderId }).from(orders).where(eq(orders.id, body.newOrderId));
        if (existing) {
          if (existing.splitFromOrderId === id) return existing.id;
          throw conflict('รหัสบิลใหม่ถูกใช้แล้ว', 'ID_IN_USE');
        }
      }
      const items = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, id), inArray(orderItems.id, body.lines.map((l) => l.itemId))));
      if (items.length !== body.lines.length) throw badRequest('รายการไม่ถูกต้อง');
      const all = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, id), sql`${orderItems.status} <> 'CANCELLED'`));
      const movingAll = body.lines.every((l) => items.find((i) => i.id === l.itemId)!.qty === l.qty) && body.lines.length === all.length;
      if (movingAll) throw badRequest('ต้องเหลือรายการไว้ในบิลเดิมอย่างน้อย 1 รายการ');
      const { order: child } = await createOrder(tx, {
        id: body.newOrderId,
        orgId: a.orgId,
        branchId,
        channel: o.channel,
        source: o.source,
        tableId: null,
        guestCount: 1,
        openedBy: a.userId,
        note: `แยกจากบิล #${o.orderNo}`,
      });
      await tx.update(orders).set({ splitFromOrderId: id, pricing: o.pricing }).where(eq(orders.id, child.id));
      let seq = 1;
      for (const l of body.lines) {
        const it = items.find((i) => i.id === l.itemId)!;
        if (it.status === 'CANCELLED') throw badRequest('รายการถูกยกเลิกแล้ว');
        if (l.qty > it.qty) throw badRequest(`จำนวนของ "${it.nameSnapshot}" เกินที่มี`);
        if (it.discountSatang > 0 && l.qty < it.qty) throw badRequest(`"${it.nameSnapshot}" มีส่วนลดรายการ ต้องแยกทั้งรายการ`);
        if (l.qty === it.qty) {
          await tx.update(orderItems).set({ orderId: child.id, seq: seq++ }).where(eq(orderItems.id, it.id));
          await tx.update(orderDiscounts).set({ orderId: child.id }).where(eq(orderDiscounts.orderItemId, it.id));
        } else {
          // Partial split: reduce the original line and create a copy with the split quantity.
          await tx.update(orderItems).set({ qty: it.qty - l.qty, lineTotalSatang: it.unitPriceSatang * (it.qty - l.qty) }).where(eq(orderItems.id, it.id));
          const { id: _old, createdAt: _c, ...rest } = it;
          await tx.insert(orderItems).values({ ...rest, id: crypto.randomUUID(), orderId: child.id, qty: l.qty, lineTotalSatang: it.unitPriceSatang * l.qty, seq: seq++ });
        }
      }
      await recalcOrder(tx, id);
      await recalcOrder(tx, child.id);
      await audit(tx, a, { action: 'order.split', targetType: 'order', targetId: id, data: { newOrderId: child.id, newOrderNo: child.orderNo, lines: body.lines } }, req.ip);
      return child.id;
    });
    emit(a.orgId, branchId, id);
    emit(a.orgId, branchId, newId, 'order.created');
    return getOrderDetail(db, a.orgId, branchId, newId);
  });

  /** Mark READY items as served from the floor (waiter) — the kitchen uses the KDS endpoints. */
  app.post('/order-items/:id/served', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [it] = await db.select().from(orderItems).where(and(eq(orderItems.id, id), eq(orderItems.branchId, branchId)));
    if (!it) throw badRequest('ไม่พบรายการ');
    await db.transaction(async (tx) => {
      await lockOrder(tx, a.orgId, branchId, it.orderId);
      const [cur] = await tx.select().from(orderItems).where(eq(orderItems.id, id)).for('update');
      if (cur.status === 'SERVED') return;
      if (cur.status !== 'READY') throw conflict('เสิร์ฟได้เฉพาะรายการที่ครัวทำเสร็จแล้ว');
      await tx.update(orderItems).set({ status: 'SERVED', servedAt: new Date() }).where(eq(orderItems.id, id));
      await refreshTableForOrder(tx, bus, it.orderId);
    });
    bus.publish({ type: 'order_item.status_changed', organizationId: a.orgId, branchId, payload: { orderId: it.orderId, itemId: id, status: 'SERVED' } });
    return getOrderDetail(db, a.orgId, branchId, it.orderId);
  });
}
