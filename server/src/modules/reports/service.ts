import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';

/**
 * Report queries. Definitions used consistently everywhere:
 *  - A *sale* is an order with status PAID or CLOSED, dated by its business_date (branch-local day).
 *  - Voided orders and CANCELLED lines are excluded from sales and reported separately.
 *  - Gross = sum of active lines before discounts; Net = Gross − discounts; Total = Net + service + VAT(excl.).
 *  - Refunds are reported separately on the day they happened (they are not netted into sales of the
 *    original day), so historical daily totals never change.
 *  - Payment-method totals come from confirmed payments of those sales minus their refunds, so a
 *    split/mixed payment is counted once per method and never double-counts the bill.
 */

export interface Range {
  orgId: string;
  branchIds: string[];
  from: string;
  to: string;
  /** Optional cut-off on payment time (for "same time last week" comparisons). */
  paidBefore?: Date;
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const rows = async <T = any>(db: DbOrTx, q: SQL): Promise<T[]> => ((await db.execute(q)) as any).rows as T[];
const ids = (list: string[]) => sql.join(list.map((i) => sql`${i}::uuid`), sql`, `);
const saleWhere = (r: Range, alias = 'o') =>
  sql`${sql.raw(alias)}.organization_id = ${r.orgId}::uuid and ${sql.raw(alias)}.branch_id in (${ids(r.branchIds)}) and ${sql.raw(alias)}.status in ('PAID','CLOSED') and ${sql.raw(alias)}.business_date between ${r.from}::date and ${r.to}::date${r.paidBefore ? sql` and ${sql.raw(alias)}.paid_at <= ${r.paidBefore.toISOString()}::timestamptz` : sql``}`;

export async function salesSummary(db: DbOrTx, r: Range) {
  const [t] = await rows(
    db,
    sql`select count(*)::int as orders, coalesce(sum(guest_count),0)::int as guests,
               coalesce(sum(subtotal_satang),0)::bigint as gross, coalesce(sum(discount_satang),0)::bigint as discounts,
               coalesce(sum(service_charge_satang),0)::bigint as service, coalesce(sum(vat_satang),0)::bigint as vat,
               coalesce(sum(grand_total_satang),0)::bigint as total
        from orders o where ${saleWhere(r)}`,
  );
  const daily = await rows(
    db,
    sql`select business_date::text as date, count(*)::int as orders, coalesce(sum(guest_count),0)::int as guests,
               coalesce(sum(subtotal_satang - discount_satang),0)::bigint as net, coalesce(sum(grand_total_satang),0)::bigint as total
        from orders o where ${saleWhere(r)} group by business_date order by business_date`,
  );
  const hourly = await rows(
    db,
    sql`select extract(hour from o.paid_at at time zone b.timezone)::int as hour, count(*)::int as orders,
               coalesce(sum(o.grand_total_satang),0)::bigint as total
        from orders o join branches b on b.id = o.branch_id where ${saleWhere(r)} group by 1 order by 1`,
  );
  const byChannel = await rows(
    db,
    sql`select channel, count(*)::int as orders, coalesce(sum(grand_total_satang),0)::bigint as total
        from orders o where ${saleWhere(r)} group by channel order by 3 desc`,
  );
  const byPayment = await rows(
    db,
    sql`select p.method, count(*)::int as count, coalesce(sum(p.amount_satang - p.refunded_satang),0)::bigint as amount
        from payments p join orders o on o.id = p.order_id
        where ${saleWhere(r)} and p.status = 'CONFIRMED' group by p.method order by 3 desc`,
  );
  const [refunds] = await rows(
    db,
    sql`select count(*)::int as count, coalesce(sum(rf.amount_satang),0)::bigint as amount
        from refunds rf join branches b on b.id = rf.branch_id
        where rf.organization_id = ${r.orgId}::uuid and rf.branch_id in (${ids(r.branchIds)})
          and (rf.created_at at time zone b.timezone)::date between ${r.from}::date and ${r.to}::date`,
  );
  const [voids] = await rows(
    db,
    sql`select count(*)::int as count,
               coalesce(sum((select sum(oi.unit_price_satang * oi.qty) from order_items oi where oi.order_id = o.id)),0)::bigint as amount
        from orders o where o.organization_id = ${r.orgId}::uuid and o.branch_id in (${ids(r.branchIds)})
          and o.status = 'VOIDED' and o.business_date between ${r.from}::date and ${r.to}::date`,
  );
  const orders = n(t.orders);
  const total = n(t.total);
  return {
    totals: {
      orders,
      guests: n(t.guests),
      grossSatang: n(t.gross),
      discountSatang: n(t.discounts),
      netSatang: n(t.gross) - n(t.discounts),
      serviceChargeSatang: n(t.service),
      vatSatang: n(t.vat),
      totalSatang: total,
      avgBillSatang: orders ? Math.round(total / orders) : 0,
      avgPerGuestSatang: n(t.guests) ? Math.round(total / n(t.guests)) : 0,
      refunds: { count: n(refunds.count), amountSatang: n(refunds.amount) },
      voids: { count: n(voids.count), amountSatang: n(voids.amount) },
    },
    daily: daily.map((d) => ({ date: d.date, orders: n(d.orders), guests: n(d.guests), netSatang: n(d.net), totalSatang: n(d.total) })),
    hourly: hourly.map((h) => ({ hour: n(h.hour), orders: n(h.orders), totalSatang: n(h.total) })),
    byChannel: byChannel.map((c) => ({ channel: c.channel, orders: n(c.orders), totalSatang: n(c.total) })),
    byPayment: byPayment.map((p) => ({ method: p.method, count: n(p.count), amountSatang: n(p.amount) })),
  };
}

export type MenuClass = 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG';

/**
 * Item performance. Cost is the actual recipe cost posted to the stock ledger when the item was sent
 * (SALE minus SALE_REVERSAL), so it is only present for items with recipes.
 * Menu engineering (Kasavana & Smith): popularity threshold = 70% of the average share, profitability
 * threshold = average contribution margin per unit — computed only over items that have costs.
 */
export async function itemPerformance(db: DbOrTx, r: Range, withCost: boolean) {
  const list = await rows(
    db,
    sql`select oi.menu_item_id as id, min(oi.name_snapshot) as name, sum(oi.qty)::int as qty,
               coalesce(sum(oi.line_total_satang),0)::bigint as revenue,
               (select -coalesce(sum(sm.value),0) from stock_movements sm
                 where sm.ref_type = 'order_item' and sm.type in ('SALE','SALE_REVERSAL')
                   and sm.ref_id in (select oi2.id::text from order_items oi2 join orders o2 on o2.id = oi2.order_id
                                     where oi2.menu_item_id = oi.menu_item_id and oi2.status <> 'CANCELLED' and ${saleWhere(r, 'o2')})) as cost,
               (select count(*) from recipes rc where rc.menu_item_id = oi.menu_item_id) > 0 as has_recipe
        from order_items oi join orders o on o.id = oi.order_id
        where ${saleWhere(r)} and oi.status <> 'CANCELLED'
        group by oi.menu_item_id order by qty desc`,
  );
  const totalQty = list.reduce((a, i) => a + n(i.qty), 0);
  const costed = list.filter((i) => i.has_recipe);
  const avgShare = list.length ? 1 / list.length : 0;
  const avgMargin = costed.length ? costed.reduce((a, i) => a + (n(i.revenue) - n(i.cost)) / Math.max(1, n(i.qty)), 0) / costed.length : 0;
  return {
    items: list.map((i) => {
      const qty = n(i.qty);
      const revenue = n(i.revenue);
      const cost = i.has_recipe ? Math.round(n(i.cost)) : null;
      const margin = cost === null ? null : revenue - cost;
      const popular = totalQty > 0 && qty / totalQty >= avgShare * 0.7;
      const profitable = margin !== null && margin / Math.max(1, qty) >= avgMargin;
      const cls: MenuClass | null = margin === null ? null : popular && profitable ? 'STAR' : popular ? 'PLOWHORSE' : profitable ? 'PUZZLE' : 'DOG';
      return {
        menuItemId: i.id,
        name: i.name,
        qty,
        revenueSatang: revenue,
        mixPct: totalQty ? Math.round((qty / totalQty) * 1000) / 10 : 0,
        ...(withCost ? { costSatang: cost, marginSatang: margin, foodCostPct: cost !== null && revenue > 0 ? Math.round((cost / revenue) * 1000) / 10 : null, menuClass: cls } : {}),
      };
    }),
    totalQty,
  };
}

/** Food cost %, waste, stock variance and purchases. Labor cost needs attendance + wage data (Prompt 15). */
export async function costReport(db: DbOrTx, r: Range) {
  const where = sql`sm.organization_id = ${r.orgId}::uuid and sm.branch_id in (${ids(r.branchIds)}) and (sm.created_at at time zone b.timezone)::date between ${r.from}::date and ${r.to}::date`;
  const byType = await rows(db, sql`select sm.type, coalesce(sum(sm.value),0)::float8 as value from stock_movements sm join branches b on b.id = sm.branch_id where ${where} group by sm.type`);
  const v = (t: string) => n(byType.find((x) => x.type === t)?.value);
  const waste = await rows(
    db,
    sql`select i.name, i.base_unit as unit, -sum(sm.qty)::float8 as qty, -sum(sm.value)::float8 as value
        from stock_movements sm join ingredients i on i.id = sm.ingredient_id join branches b on b.id = sm.branch_id
        where ${where} and sm.type = 'WASTE' group by i.name, i.base_unit order by 4 desc`,
  );
  const variance = await rows(
    db,
    sql`select i.name, i.base_unit as unit, sum(sm.qty)::float8 as qty, sum(sm.value)::float8 as value
        from stock_movements sm join ingredients i on i.id = sm.ingredient_id join branches b on b.id = sm.branch_id
        where ${where} and sm.type in ('COUNT','ADJUST') group by i.name, i.base_unit order by 4 asc`,
  );
  const s = await salesSummary(db, r);
  const cogs = Math.round(-(v('SALE') + v('SALE_REVERSAL')));
  const net = s.totals.netSatang;
  const labor = await laborCost(db, r);
  return {
    netSalesSatang: net,
    cogsSatang: cogs,
    foodCostPct: net > 0 ? Math.round((cogs / net) * 1000) / 10 : null,
    wasteSatang: Math.round(-v('WASTE')),
    waste: waste.map((w) => ({ name: w.name, unit: w.unit, qty: n(w.qty), valueSatang: Math.round(n(w.value)) })),
    varianceSatang: Math.round(v('COUNT') + v('ADJUST')),
    variance: variance.map((w) => ({ name: w.name, unit: w.unit, qty: n(w.qty), valueSatang: Math.round(n(w.value)) })),
    purchasesSatang: Math.round(v('PURCHASE')),
    labor,
    laborCostPct: labor.available && net > 0 ? Math.round((labor.costSatang / net) * 1000) / 10 : null,
  };
}

/** Hook for Prompt 15 (attendance × wages). Until then labor cost is reported as unavailable. */
export const laborCostProvider: { fn: ((db: DbOrTx, r: Range) => Promise<{ available: boolean; costSatang: number; note: string }>) | null } = { fn: null };
async function laborCost(db: DbOrTx, r: Range) {
  if (laborCostProvider.fn) return laborCostProvider.fn(db, r);
  return { available: false, costSatang: 0, note: 'ยังไม่มีข้อมูลเวลาทำงานและค่าจ้างพนักงาน' };
}

/** Control report: voids, discounts, refunds and cash variance by staff member. */
export async function staffControls(db: DbOrTx, r: Range) {
  const voids = await rows(
    db,
    sql`select u.name, count(*)::int as count,
               coalesce(sum((select sum(oi.unit_price_satang * oi.qty) from order_items oi where oi.order_id = o.id)),0)::bigint as amount
        from orders o left join users u on u.id = o.voided_by
        where o.organization_id = ${r.orgId}::uuid and o.branch_id in (${ids(r.branchIds)}) and o.status = 'VOIDED'
          and o.business_date between ${r.from}::date and ${r.to}::date group by u.name order by 2 desc`,
  );
  const cancels = await rows(
    db,
    sql`select u.name, count(*)::int as count, coalesce(sum(oi.unit_price_satang * oi.qty),0)::bigint as amount
        from order_items oi join orders o on o.id = oi.order_id left join users u on u.id = oi.cancelled_by
        where o.organization_id = ${r.orgId}::uuid and o.branch_id in (${ids(r.branchIds)}) and o.status <> 'VOIDED'
          and oi.status = 'CANCELLED' and oi.sent_at is not null and o.business_date between ${r.from}::date and ${r.to}::date
        group by u.name order by 2 desc`,
  );
  const discounts = await rows(
    db,
    sql`select u.name as given_by, a.name as approved_by, count(*)::int as count, coalesce(sum(d.amount_satang),0)::bigint as amount,
               bool_or(d.promotion_id is not null) as promotion
        from order_discounts d join orders o on o.id = d.order_id
        left join users u on u.id = d.created_by left join users a on a.id = d.approved_by
        where ${saleWhere(r)} and d.removed_at is null group by u.name, a.name order by 4 desc`,
  );
  const refunds = await rows(
    db,
    sql`select u.name, a.name as approved_by, count(*)::int as count, coalesce(sum(rf.amount_satang),0)::bigint as amount
        from refunds rf join branches b on b.id = rf.branch_id left join users u on u.id = rf.created_by left join users a on a.id = rf.approved_by
        where rf.organization_id = ${r.orgId}::uuid and rf.branch_id in (${ids(r.branchIds)})
          and (rf.created_at at time zone b.timezone)::date between ${r.from}::date and ${r.to}::date
        group by u.name, a.name order by 4 desc`,
  );
  const cash = await rows(
    db,
    sql`select s.id, u.name, s.business_date::text as date, s.expected_cash_satang as expected, s.counted_cash_satang as counted, s.variance_satang as variance
        from shifts s left join users u on u.id = s.user_id
        where s.organization_id = ${r.orgId}::uuid and s.branch_id in (${ids(r.branchIds)}) and s.status = 'CLOSED'
          and s.business_date between ${r.from}::date and ${r.to}::date order by s.closed_at`,
  );
  const sales = await rows(
    db,
    sql`select u.name, count(*)::int as orders, coalesce(sum(o.grand_total_satang),0)::bigint as total
        from orders o left join users u on u.id = o.opened_by where ${saleWhere(r)} group by u.name order by 3 desc`,
  );
  return {
    voids: voids.map((x) => ({ name: x.name, count: n(x.count), amountSatang: n(x.amount) })),
    cancelledItems: cancels.map((x) => ({ name: x.name, count: n(x.count), amountSatang: n(x.amount) })),
    discounts: discounts.map((x) => ({ givenBy: x.given_by, approvedBy: x.approved_by, count: n(x.count), amountSatang: n(x.amount), promotion: !!x.promotion })),
    refunds: refunds.map((x) => ({ name: x.name, approvedBy: x.approved_by, count: n(x.count), amountSatang: n(x.amount) })),
    cashVariance: cash.map((x) => ({ shiftId: x.id, name: x.name, date: x.date, expectedSatang: n(x.expected), countedSatang: n(x.counted), varianceSatang: n(x.variance) })),
    salesByStaff: sales.map((x) => ({ name: x.name, orders: n(x.orders), totalSatang: n(x.total) })),
  };
}

/** Output-VAT summary by business day (supporting data for ภ.พ.30 — not a filed return). */
export async function taxSummary(db: DbOrTx, r: Range) {
  const days = await rows(
    db,
    sql`select o.business_date::text as date, count(*)::int as receipts, min(o.receipt_no) as first_no, max(o.receipt_no) as last_no,
               coalesce(sum(o.grand_total_satang - case when (o.pricing->>'vatMode') = 'NONE' then 0 else o.vat_satang end),0)::bigint as base,
               coalesce(sum(o.vat_satang),0)::bigint as vat, coalesce(sum(o.grand_total_satang),0)::bigint as total,
               count(*) filter (where (o.pricing->>'vatMode') = 'NONE')::int as non_vat
        from orders o where ${saleWhere(r)} group by o.business_date order by o.business_date`,
  );
  const invoices = await rows(
    db,
    sql`select ti.invoice_no, ti.buyer_name, ti.buyer_tax_id, ti.issued_at, (ti.snapshot->>'total')::bigint as total, (ti.snapshot->>'vat')::bigint as vat
        from tax_invoices ti join orders o on o.id = ti.order_id where ${saleWhere(r)} and ti.cancelled_at is null order by ti.invoice_no`,
  );
  return {
    days: days.map((d) => ({ date: d.date, receipts: n(d.receipts), firstNo: d.first_no, lastNo: d.last_no, taxableBaseSatang: n(d.base), vatSatang: n(d.vat), totalSatang: n(d.total), nonVatReceipts: n(d.non_vat) })),
    fullTaxInvoices: invoices.map((i) => ({ invoiceNo: i.invoice_no, buyerName: i.buyer_name, buyerTaxId: i.buyer_tax_id, issuedAt: i.issued_at, totalSatang: n(i.total), vatSatang: n(i.vat) })),
    disclaimer: 'สรุปจากข้อมูลในระบบเพื่อประกอบการยื่นภาษี ไม่ใช่แบบ ภ.พ.30 และไม่รับรองความถูกต้องทางกฎหมาย — ตรวจสอบกับผู้ทำบัญชี',
  };
}

/** Table turnover and seating time for dine-in sales. */
export async function tableReport(db: DbOrTx, r: Range) {
  const [t] = await rows(
    db,
    sql`select count(*)::int as orders, coalesce(sum(guest_count),0)::int as guests,
               coalesce(avg(extract(epoch from (paid_at - opened_at)) / 60), 0)::float8 as avg_minutes
        from orders o where ${saleWhere(r)} and o.channel = 'DINE_IN' and o.table_id is not null`,
  );
  const [{ tables }] = await rows(db, sql`select count(*)::int as tables from tables where branch_id in (${ids(r.branchIds)}) and archived_at is null`);
  const dayCount = Math.max(1, Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1);
  return {
    dineInOrders: n(t.orders),
    guests: n(t.guests),
    tables: n(tables),
    days: dayCount,
    turnsPerTablePerDay: n(tables) ? Math.round((n(t.orders) / n(tables) / dayCount) * 100) / 100 : null,
    avgSeatingMinutes: Math.round(n(t.avg_minutes)),
  };
}

export async function customerReport(db: DbOrTx, r: Range) {
  const [t] = await rows(
    db,
    sql`with s as (select o.customer_id, min(o.business_date) over (partition by o.customer_id) as first_in_range from orders o where ${saleWhere(r)} and o.customer_id is not null)
        select count(distinct s.customer_id)::int as members,
               count(distinct s.customer_id) filter (where not exists (select 1 from orders p where p.customer_id = s.customer_id and p.status in ('PAID','CLOSED') and p.business_date < ${r.from}::date))::int as new_members
        from s`,
  );
  const [all] = await rows(db, sql`select count(*)::int as orders, count(customer_id)::int as member_orders from orders o where ${saleWhere(r)}`);
  return { memberOrders: n(all.member_orders), totalOrders: n(all.orders), members: n(t?.members), newMembers: n(t?.new_members), returningMembers: n(t?.members) - n(t?.new_members) };
}
