import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@shared/permissions';
import { dateString } from '@shared/validation';
import { diningTables, orders } from '../../db/schema';
import { accessibleBranches, requireAuth, resolvePermissions, type AuthContext } from '../../lib/auth';
import { toCsv } from '../../lib/csv';
import { badRequest, forbidden, parse } from '../../lib/errors';
import { addDays, businessDate } from '../../lib/time';
import { branchSettings } from '../menu/service';
import { costReport, customerReport, itemPerformance, salesSummary, staffControls, tableReport, taxSummary, type Range } from './service';

const rangeQuery = z.object({
  from: dateString,
  to: dateString,
  /** "current" (default), "all", or comma-separated branch ids. */
  branches: z.string().max(4000).default('current'),
});

/** Branches in scope where the user holds `perm` (reports can span branches for owners/area managers). */
async function scopedRange(db: any, req: FastifyRequest, perm: Permission): Promise<{ a: AuthContext; range: Range }> {
  const a = requireAuth(req);
  const q = parse(rangeQuery, req.query);
  if (q.from > q.to) throw badRequest('วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด');
  if (Date.parse(q.to) - Date.parse(q.from) > 400 * 86_400_000) throw badRequest('ช่วงรายงานยาวเกิน 400 วัน');
  const accessible = await accessibleBranches(db, a.userId, a.orgId);
  let wanted: string[];
  if (q.branches === 'current') wanted = a.branchId ? [a.branchId] : [];
  else if (q.branches === 'all') wanted = accessible.map((b) => b.id);
  else wanted = q.branches.split(',').filter(Boolean);
  const allowed: string[] = [];
  for (const id of wanted) {
    if (!accessible.some((b) => b.id === id)) throw forbidden('ไม่มีสิทธิ์ดูรายงานของสาขานี้');
    const { permissions } = await resolvePermissions(db, a.userId, id);
    if (permissions.has(perm)) allowed.push(id);
    else if (q.branches !== 'all') throw forbidden('ไม่มีสิทธิ์ดูรายงานนี้');
  }
  if (!allowed.length) throw forbidden('ไม่มีสิทธิ์ดูรายงานนี้');
  return { a, range: { orgId: a.orgId, branchIds: allowed, from: q.from, to: q.to } };
}

export default async function reportRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  app.get('/reports/sales', async (req) => {
    const { range } = await scopedRange(db, req, 'report.view_sales');
    return { range, ...(await salesSummary(db, range)), tables: await tableReport(db, range), customers: await customerReport(db, range) };
  });

  app.get('/reports/items', async (req) => {
    const { a, range } = await scopedRange(db, req, 'report.view_sales');
    const withCost = a.permissions.has('report.view_profit');
    return { range, withCost, ...(await itemPerformance(db, range, withCost)) };
  });

  app.get('/reports/costs', async (req) => {
    const { range } = await scopedRange(db, req, 'report.view_profit');
    return { range, ...(await costReport(db, range)) };
  });

  app.get('/reports/staff', async (req) => {
    const { range } = await scopedRange(db, req, 'report.view_staff');
    return { range, ...(await staffControls(db, range)) };
  });

  app.get('/reports/tax', async (req) => {
    const { range } = await scopedRange(db, req, 'report.view_sales');
    return { range, ...(await taxSummary(db, range)) };
  });

  /** Drill-down: the sale orders behind a day of a report. */
  app.get('/reports/orders', async (req) => {
    const { range } = await scopedRange(db, req, 'report.view_sales');
    const list = await db
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        receiptNo: orders.receiptNo,
        businessDate: orders.businessDate,
        channel: orders.channel,
        status: orders.status,
        tableName: diningTables.name,
        guestCount: orders.guestCount,
        grandTotalSatang: orders.grandTotalSatang,
        discountSatang: orders.discountSatang,
        paidAt: orders.paidAt,
      })
      .from(orders)
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(
        and(
          eq(orders.organizationId, range.orgId),
          inArray(orders.branchId, range.branchIds),
          inArray(orders.status, ['PAID', 'CLOSED', 'VOIDED']),
          sql`${orders.businessDate} between ${range.from}::date and ${range.to}::date`,
        ),
      )
      .orderBy(orders.paidAt)
      .limit(2000);
    return { orders: list };
  });

  /** Owner/manager live dashboard: today so far vs the same weekday last week, plus live floor state. */
  app.get('/reports/dashboard', async (req) => {
    const a = requireAuth(req);
    if (!a.permissions.has('report.view_sales')) throw forbidden();
    if (!a.branchId) throw badRequest('เลือกสาขาก่อน');
    const s = await branchSettings(db, a.branchId);
    const today = businessDate(s.timezone);
    const range = (from: string, to: string): Range => ({ orgId: a.orgId, branchIds: [a.branchId!], from, to });
    const [now, lastWeek, week] = await Promise.all([salesSummary(db, range(today, today)), salesSummary(db, { ...range(addDays(today, -7), addDays(today, -7)), paidBefore: new Date(Date.now() - 7 * 86_400_000) }), salesSummary(db, range(addDays(today, -6), today))]);
    const [live] = ((await db.execute(sql`select
        (select count(*) from orders where branch_id = ${a.branchId}::uuid and status in ('OPEN','BILL_REQUESTED'))::int as open_orders,
        (select coalesce(sum(grand_total_satang),0) from orders where branch_id = ${a.branchId}::uuid and status in ('OPEN','BILL_REQUESTED'))::bigint as open_amount,
        (select count(*) from tables where branch_id = ${a.branchId}::uuid and archived_at is null and current_order_id is not null)::int as occupied_tables,
        (select count(*) from tables where branch_id = ${a.branchId}::uuid and archived_at is null)::int as tables,
        (select count(*) from order_items where branch_id = ${a.branchId}::uuid and status in ('SENT','PREPARING'))::int as in_kitchen,
        (select count(*) from payments where branch_id = ${a.branchId}::uuid and status = 'PENDING_CONFIRMATION')::int as pending_payments`)) as any).rows;
    const top = await itemPerformance(db, range(today, today), false);
    return {
      today,
      now: now.totals,
      sameDayLastWeek: lastWeek.totals,
      hourly: now.hourly,
      last7Days: week.daily,
      byChannel: now.byChannel,
      byPayment: now.byPayment,
      topItems: top.items.slice(0, 5),
      live: {
        openOrders: Number(live.open_orders),
        openAmountSatang: Number(live.open_amount),
        occupiedTables: Number(live.occupied_tables),
        tables: Number(live.tables),
        itemsInKitchen: Number(live.in_kitchen),
        pendingPayments: Number(live.pending_payments),
      },
    };
  });

  /** CSV export (Excel-compatible, UTF-8 BOM, formula-injection safe). PDF = print view in the browser. */
  app.get('/reports/export', async (req, reply) => {
    const a = requireAuth(req);
    if (!a.permissions.has('report.export')) throw forbidden('ไม่มีสิทธิ์ส่งออกรายงาน');
    const { report } = parse(z.object({ report: z.enum(['daily', 'items', 'staff', 'tax', 'orders', 'costs']) }), req.query);
    const perm: Permission = report === 'staff' ? 'report.view_staff' : report === 'costs' ? 'report.view_profit' : 'report.view_sales';
    const { range } = await scopedRange(db, req, perm);
    const b = (v: number | null | undefined) => (v === null || v === undefined ? '' : (v / 100).toFixed(2));
    let csv: string;
    if (report === 'daily') {
      const r = await salesSummary(db, range);
      csv = toCsv(['วันที่', 'จำนวนบิล', 'ลูกค้า', 'ยอดสุทธิก่อนภาษี/ค่าบริการ', 'ยอดรวม'], r.daily.map((d) => [d.date, d.orders, d.guests, b(d.netSatang), b(d.totalSatang)]));
    } else if (report === 'items') {
      const withCost = a.permissions.has('report.view_profit');
      const r = await itemPerformance(db, range, withCost);
      csv = toCsv(
        ['เมนู', 'จำนวน', 'ยอดขาย', 'สัดส่วน %', ...(withCost ? ['ต้นทุน', 'กำไรขั้นต้น', 'Food cost %', 'Menu engineering'] : [])],
        r.items.map((i: any) => [i.name, i.qty, b(i.revenueSatang), i.mixPct, ...(withCost ? [b(i.costSatang), b(i.marginSatang), i.foodCostPct ?? '', i.menuClass ?? ''] : [])]),
      );
    } else if (report === 'staff') {
      const r = await staffControls(db, range);
      csv = toCsv(
        ['ประเภท', 'พนักงาน', 'ผู้อนุมัติ', 'จำนวน', 'มูลค่า'],
        [
          ...r.voids.map((x) => ['Void บิล', x.name, '', x.count, b(x.amountSatang)]),
          ...r.cancelledItems.map((x) => ['ยกเลิกรายการ', x.name, '', x.count, b(x.amountSatang)]),
          ...r.discounts.map((x) => [x.promotion ? 'ส่วนลด/โปรโมชัน' : 'ส่วนลด', x.givenBy, x.approvedBy ?? '', x.count, b(x.amountSatang)]),
          ...r.refunds.map((x) => ['คืนเงิน', x.name, x.approvedBy ?? '', x.count, b(x.amountSatang)]),
          ...r.cashVariance.map((x) => [`ส่วนต่างเงินสด ${x.date}`, x.name, '', 1, b(x.varianceSatang)]),
        ],
      );
    } else if (report === 'tax') {
      const r = await taxSummary(db, range);
      csv = toCsv(['วันที่', 'จำนวนใบเสร็จ', 'เลขที่เริ่ม', 'เลขที่สุดท้าย', 'มูลค่าก่อนภาษี', 'ภาษีขาย', 'รวม'], r.days.map((d) => [d.date, d.receipts, d.firstNo ?? '', d.lastNo ?? '', b(d.taxableBaseSatang), b(d.vatSatang), b(d.totalSatang)]));
    } else if (report === 'costs') {
      const r = await costReport(db, range);
      csv = toCsv(['รายการ', 'หน่วย', 'จำนวน', 'มูลค่า'], [...r.waste.map((w) => [`ของเสีย: ${w.name}`, w.unit, w.qty, b(w.valueSatang)]), ...r.variance.map((w) => [`ส่วนต่างสต็อก: ${w.name}`, w.unit, w.qty, b(w.valueSatang)])]);
    } else {
      const list = await db
        .select({ orderNo: orders.orderNo, receiptNo: orders.receiptNo, date: orders.businessDate, channel: orders.channel, status: orders.status, total: orders.grandTotalSatang })
        .from(orders)
        .where(and(eq(orders.organizationId, range.orgId), inArray(orders.branchId, range.branchIds), sql`${orders.businessDate} between ${range.from}::date and ${range.to}::date`, inArray(orders.status, ['PAID', 'CLOSED', 'VOIDED'])));
      csv = toCsv(['บิล', 'ใบเสร็จ', 'วันที่', 'ช่องทาง', 'สถานะ', 'ยอด'], list.map((o) => [o.orderNo, o.receiptNo ?? '', o.date, o.channel, o.status, b(o.total)]));
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${report}-${range.from}-${range.to}.csv"`);
    return csv;
  });
}
