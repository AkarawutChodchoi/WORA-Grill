import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { applyBps } from '@shared/money';
import { computeTotals, lineNet, type BillDiscount } from '@shared/pricing';
import { canTransition, ITEM_TRANSITIONS, ORDER_TRANSITIONS, type ItemStatus, type OrderStatus } from '@shared/states';
import type { DbOrTx } from '../../db/client';
import { diningTables, orderDiscounts, orderItems, orders, users } from '../../db/schema';
import type { EventBus } from '../../lib/events';
import { conflict, notFound, unprocessable } from '../../lib/errors';

export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;

/** Lock the order row for the rest of the transaction (serialises concurrent edits of one bill). */
export async function lockOrder(db: DbOrTx, orgId: string, branchId: string, orderId: string): Promise<Order> {
  const [o] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.organizationId, orgId), eq(orders.branchId, branchId)))
    .for('update');
  if (!o) throw notFound('บิล');
  return o;
}

export function assertOrderTransition(o: Order, to: OrderStatus) {
  if (!canTransition(ORDER_TRANSITIONS, o.status, to)) throw conflict(`บิลสถานะ ${o.status} เปลี่ยนเป็น ${to} ไม่ได้`, 'INVALID_STATE');
}

export function assertEditable(o: Order) {
  if (o.status !== 'OPEN') throw conflict(o.status === 'BILL_REQUESTED' ? 'บิลอยู่ระหว่างเช็กบิล กด "แก้ไขบิล" ก่อนเพิ่มรายการ' : 'บิลนี้ปิดแล้ว แก้ไขไม่ได้', 'ORDER_NOT_EDITABLE');
}

export function assertItemTransition(i: OrderItem, to: ItemStatus) {
  if (!canTransition(ITEM_TRANSITIONS, i.status, to)) throw conflict(`รายการ "${i.nameSnapshot}" สถานะ ${i.status} เปลี่ยนเป็น ${to} ไม่ได้`, 'INVALID_STATE');
}

/**
 * Recompute and persist the bill totals from its lines and discounts (single source of truth:
 * shared/pricing.ts). Called inside the same transaction as any change to lines or discounts.
 */
export async function recalcOrder(db: DbOrTx, orderId: string): Promise<Order> {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const discounts = await db
    .select()
    .from(orderDiscounts)
    .where(and(eq(orderDiscounts.orderId, orderId), isNull(orderDiscounts.removedAt)))
    .orderBy(asc(orderDiscounts.createdAt));

  // Item-level discounts: recompute each line's discount from its (active) discount rows.
  for (const it of items) {
    const ds = discounts.filter((d) => d.scope === 'ITEM' && d.orderItemId === it.id);
    const gross = it.unitPriceSatang * it.qty;
    let amount = 0;
    for (const d of ds) {
      const a = d.type === 'PERCENT' ? applyBps(gross - amount, d.value) : d.value;
      const applied = Math.min(a, gross - amount);
      amount += applied;
      if (applied !== d.amountSatang) await db.update(orderDiscounts).set({ amountSatang: applied }).where(eq(orderDiscounts.id, d.id));
    }
    const lineTotal = lineNet({ unitPriceSatang: it.unitPriceSatang, qty: it.qty, discountSatang: amount });
    if (amount !== it.discountSatang || lineTotal !== it.lineTotalSatang) {
      await db.update(orderItems).set({ discountSatang: amount, lineTotalSatang: lineTotal }).where(eq(orderItems.id, it.id));
      it.discountSatang = amount;
    }
  }

  const bill = discounts.filter((d) => d.scope === 'BILL');
  const t = computeTotals(
    items.map((i) => ({ unitPriceSatang: i.unitPriceSatang, qty: i.qty, discountSatang: i.discountSatang, status: i.status })),
    bill.map((d): BillDiscount => ({ type: d.type, value: d.value })),
    o.pricing as any,
  );
  // Snapshot the satang each bill discount actually took (in application order).
  let remaining = t.subtotalSatang - t.itemDiscountSatang;
  for (const d of bill) {
    const a = Math.min(d.type === 'PERCENT' ? applyBps(remaining, d.value) : d.value, remaining);
    remaining -= a;
    if (a !== d.amountSatang) await db.update(orderDiscounts).set({ amountSatang: a }).where(eq(orderDiscounts.id, d.id));
  }
  const [updated] = await db
    .update(orders)
    .set({
      subtotalSatang: t.subtotalSatang,
      discountSatang: t.discountSatang,
      serviceChargeSatang: t.serviceChargeSatang,
      vatSatang: t.vatSatang,
      grandTotalSatang: t.grandTotalSatang,
      version: sql`${orders.version} + 1`,
    })
    .where(eq(orders.id, orderId))
    .returning();
  return updated;
}

/** Full bill view for POS/waiter screens. */
export async function getOrderDetail(db: DbOrTx, orgId: string, branchId: string, orderId: string) {
  const [o] = await db
    .select({ order: orders, tableName: diningTables.name, openedByName: users.name })
    .from(orders)
    .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
    .leftJoin(users, eq(users.id, orders.openedBy))
    .where(and(eq(orders.id, orderId), eq(orders.organizationId, orgId), eq(orders.branchId, branchId)));
  if (!o) throw notFound('บิล');
  const [items, discounts] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.seq), asc(orderItems.createdAt)),
    db.select().from(orderDiscounts).where(and(eq(orderDiscounts.orderId, orderId), isNull(orderDiscounts.removedAt))).orderBy(asc(orderDiscounts.createdAt)),
  ]);
  const extras = await orderDetailExtensions.reduce(async (acc, ext) => ({ ...(await acc), ...(await ext(db, o.order)) }), Promise.resolve({} as Record<string, unknown>));
  return { ...o.order, tableName: o.tableName, openedByName: o.openedByName, items, discounts, ...extras };
}

/** Later modules (payments, loyalty…) contribute extra fields to the order detail. */
export const orderDetailExtensions: ((db: DbOrTx, o: Order) => Promise<Record<string, unknown>>)[] = [];

export async function nextSeq(db: DbOrTx, orderId: string): Promise<number> {
  const r = await db.execute<{ m: number }>(sql`select coalesce(max(seq), 0)::int as m from order_items where order_id = ${orderId}`);
  return ((r as any).rows?.[0]?.m ?? 0) + 1;
}

/**
 * Send items to the kitchen: PENDING → SENT. Held items are skipped unless explicitly listed (fire).
 * Returns the items that changed; re-sending is a no-op (idempotent).
 */
export async function sendItems(db: DbOrTx, bus: EventBus | null, o: Order, opts: { itemIds?: string[]; includeHeld?: boolean; course?: number } = {}) {
  const pending = await db
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.orderId, o.id), eq(orderItems.status, 'PENDING'), opts.itemIds?.length ? inArray(orderItems.id, opts.itemIds) : undefined));
  // Lines a guest ordered by QR wait for staff approval (when the branch requires it) before they can be sent.
  const toSend = pending.filter((i) => !i.awaitingApproval && (opts.course ? i.course === opts.course : true) && (!i.held || opts.includeHeld || opts.itemIds?.includes(i.id)));
  if (toSend.length === 0) return [];
  const now = new Date();
  await db
    .update(orderItems)
    .set({ status: 'SENT', sentAt: now, held: false })
    .where(inArray(orderItems.id, toSend.map((i) => i.id)));
  bus?.publish({
    type: 'kitchen.ticket',
    organizationId: o.organizationId,
    branchId: o.branchId,
    payload: { orderId: o.id, orderNo: o.orderNo, itemIds: toSend.map((i) => i.id), stations: [...new Set(toSend.map((i) => i.stationCode ?? ''))] },
  });
  return toSend;
}

export function assertCancellable(i: OrderItem) {
  if (i.status === 'SERVED') throw unprocessable('รายการที่เสิร์ฟแล้วยกเลิกไม่ได้ ใช้ส่วนลดหรือคืนเงินแทน', 'ITEM_SERVED');
  assertItemTransition(i, 'CANCELLED');
}
