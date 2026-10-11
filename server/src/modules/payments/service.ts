import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { branches, cashMovements, docCounters, orders, payments, refunds, shifts } from '../../db/schema';
import type { AuthContext } from '../../lib/auth';
import type { EventBus } from '../../lib/events';
import { badRequest, conflict } from '../../lib/errors';
import { orderHooks, runOrderHook } from '../orders/hooks';
import { orderDetailExtensions, type Order } from '../orders/service';
import { releaseTable } from '../tables/service';

/** Next running document number, e.g. receipts per branch per year. */
export async function nextDocNo(db: DbOrTx, branchId: string, docType: string, period: string): Promise<number> {
  const [row] = await db
    .insert(docCounters)
    .values({ branchId, docType, period, lastNo: 1 })
    .onConflictDoUpdate({ target: [docCounters.branchId, docCounters.docType, docCounters.period], set: { lastNo: sql`${docCounters.lastNo} + 1` } })
    .returning({ lastNo: docCounters.lastNo });
  return row.lastNo;
}

export async function openShiftFor(db: DbOrTx, branchId: string, userId: string) {
  const [s] = await db.select().from(shifts).where(and(eq(shifts.branchId, branchId), eq(shifts.userId, userId), eq(shifts.status, 'OPEN')));
  return s ?? null;
}

/** Money that currently counts towards the bill: confirmed payments minus refunds. */
export async function paidAmount(db: DbOrTx, orderId: string) {
  const rows = await db.select().from(payments).where(eq(payments.orderId, orderId));
  const confirmed = rows.filter((p) => p.status === 'CONFIRMED').reduce((a, p) => a + p.amountSatang - p.refundedSatang, 0);
  const pending = rows.filter((p) => p.status === 'PENDING_CONFIRMATION').reduce((a, p) => a + p.amountSatang, 0);
  return { confirmed, pending };
}

/**
 * Re-sync order.paid_satang and, when the bill is fully covered by confirmed payments, move it to PAID:
 * assign the receipt number, release the table for cleaning and run paid hooks (loyalty, stock…).
 */
export async function settleOrder(db: DbOrTx, bus: EventBus | null, actor: Pick<AuthContext, 'orgId' | 'branchId' | 'userId'>, orderId: string, shiftId: string | null) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId)).for('update');
  const { confirmed } = await paidAmount(db, orderId);
  await db.update(orders).set({ paidSatang: confirmed }).where(eq(orders.id, orderId));
  if (!['OPEN', 'BILL_REQUESTED'].includes(o.status) || confirmed < o.grandTotalSatang) return { ...o, paidSatang: confirmed } as Order;
  const [b] = await db.select({ code: branches.code }).from(branches).where(eq(branches.id, o.branchId));
  const year = o.businessDate.slice(0, 4);
  const receiptNo = o.receiptNo ?? `${b.code}${year}-${String(await nextDocNo(db, o.branchId, 'RECEIPT', year)).padStart(6, '0')}`;
  const [paid] = await db
    .update(orders)
    .set({ status: 'PAID', paidAt: new Date(), closedBy: actor.userId, shiftId: shiftId ?? o.shiftId, receiptNo, version: sql`${orders.version} + 1` })
    .where(eq(orders.id, orderId))
    .returning();
  if (o.tableId) await releaseTable(db, bus, o.tableId, 'CLEANING');
  await runOrderHook(orderHooks.orderPaid, { db, actor, bus }, paid);
  bus?.publish({ type: 'payment.confirmed', organizationId: o.organizationId, branchId: o.branchId, payload: { orderId, status: 'PAID' } });
  return paid;
}

/**
 * Bill-changing actions (void, merge, split, discounts, promotions) are refused while any money is
 * confirmed OR pending on the bill — a pending PromptPay/transfer may still arrive.
 */
export async function assertNoMoney(db: DbOrTx, orderId: string, message = 'บิลนี้มีการชำระเงินหรือรอยืนยันการชำระอยู่ ต้องคืนเงิน/ยกเลิกการชำระก่อน') {
  const { confirmed, pending } = await paidAmount(db, orderId);
  if (confirmed > 0 || pending > 0) throw conflict(message, 'HAS_PAYMENTS');
}

export function assertMethodEnabled(enabled: string[], method: string) {
  if (!enabled.includes(method)) throw badRequest(`สาขานี้ยังไม่เปิดรับชำระด้วย ${method}`);
}

export interface ShiftReport {
  shiftId: string;
  cashier: string | null;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  openingFloatSatang: number;
  orders: { count: number; guests: number; grossSatang: number; discountSatang: number; serviceChargeSatang: number; vatSatang: number; totalSatang: number };
  byMethod: { method: string; count: number; amountSatang: number }[];
  byChannel: { channel: string; count: number; totalSatang: number }[];
  refunds: { count: number; amountSatang: number; cashSatang: number };
  voids: { count: number; amountSatang: number };
  cashMovements: { payInSatang: number; payOutSatang: number; noSaleCount: number };
  pendingPayments: number;
  expectedCashSatang: number;
  countedCashSatang: number | null;
  varianceSatang: number | null;
}

/** X/Z report for one shift, computed only from recorded transactions. */
export async function buildShiftReport(db: DbOrTx, shiftId: string): Promise<ShiftReport> {
  const [s] = await db.execute<any>(sql`select s.*, u.name as cashier from shifts s left join users u on u.id = s.user_id where s.id = ${shiftId}`).then((r: any) => r.rows);
  const pays = await db.select().from(payments).where(eq(payments.shiftId, shiftId));
  const confirmed = pays.filter((p) => p.status === 'CONFIRMED');
  const orderIds = [...new Set(confirmed.map((p) => p.orderId))];
  const paidOrders = orderIds.length ? await db.select().from(orders).where(and(inArray(orders.id, orderIds), eq(orders.shiftId, shiftId))) : [];
  const rf = await db.select().from(refunds).where(eq(refunds.shiftId, shiftId));
  const mv = await db.select().from(cashMovements).where(eq(cashMovements.shiftId, shiftId));
  const voided = await db
    .select({ n: sql<number>`count(*)::int`, amt: sql<number>`coalesce(sum((select coalesce(sum(oi.unit_price_satang * oi.qty),0) from order_items oi where oi.order_id = orders.id)),0)::bigint` })
    .from(orders)
    .where(and(eq(orders.branchId, s.branch_id), eq(orders.status, 'VOIDED'), sql`${orders.voidedAt} >= ${s.opened_at} and ${orders.voidedAt} < coalesce(${s.closed_at}, now())`));

  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const byMethod = new Map<string, { count: number; amountSatang: number }>();
  for (const p of confirmed) {
    const m = byMethod.get(p.method) ?? { count: 0, amountSatang: 0 };
    m.count += 1;
    m.amountSatang += p.amountSatang;
    byMethod.set(p.method, m);
  }
  const byChannel = new Map<string, { count: number; totalSatang: number }>();
  for (const o of paidOrders) {
    const c = byChannel.get(o.channel) ?? { count: 0, totalSatang: 0 };
    c.count += 1;
    c.totalSatang += o.grandTotalSatang;
    byChannel.set(o.channel, c);
  }
  const cashIn = sum(confirmed.filter((p) => p.method === 'CASH'), (p) => p.amountSatang);
  const cashRefunds = sum(rf.filter((r) => r.method === 'CASH'), (r) => r.amountSatang);
  const payIn = sum(mv.filter((m) => m.type === 'PAY_IN'), (m) => m.amountSatang);
  const payOut = sum(mv.filter((m) => m.type === 'PAY_OUT'), (m) => m.amountSatang);
  const expected = s.opening_float_satang + cashIn + payIn - payOut - cashRefunds;
  return {
    shiftId,
    cashier: s.cashier,
    status: s.status,
    openedAt: s.opened_at,
    closedAt: s.closed_at,
    openingFloatSatang: s.opening_float_satang,
    orders: {
      count: paidOrders.length,
      guests: sum(paidOrders, (o) => o.guestCount),
      grossSatang: sum(paidOrders, (o) => o.subtotalSatang),
      discountSatang: sum(paidOrders, (o) => o.discountSatang),
      serviceChargeSatang: sum(paidOrders, (o) => o.serviceChargeSatang),
      vatSatang: sum(paidOrders, (o) => o.vatSatang),
      totalSatang: sum(paidOrders, (o) => o.grandTotalSatang),
    },
    byMethod: [...byMethod].map(([method, v]) => ({ method, ...v })),
    byChannel: [...byChannel].map(([channel, v]) => ({ channel, ...v })),
    refunds: { count: rf.length, amountSatang: sum(rf, (r) => r.amountSatang), cashSatang: cashRefunds },
    voids: { count: voided[0]?.n ?? 0, amountSatang: Number(voided[0]?.amt ?? 0) },
    cashMovements: { payInSatang: payIn, payOutSatang: payOut, noSaleCount: mv.filter((m) => m.type === 'NO_SALE').length },
    pendingPayments: pays.filter((p) => p.status === 'PENDING_CONFIRMATION').length,
    expectedCashSatang: expected,
    countedCashSatang: s.counted_cash_satang,
    varianceSatang: s.counted_cash_satang == null ? null : s.counted_cash_satang - expected,
  };
}

// Payments appear in the order detail returned to POS screens.
orderDetailExtensions.push(async (db, o) => ({
  payments: await db.select().from(payments).where(eq(payments.orderId, o.id)).orderBy(payments.createdAt),
}));
