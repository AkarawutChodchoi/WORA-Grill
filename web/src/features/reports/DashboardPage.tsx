import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router';
import { BarChart, BarList } from '../../components/BarChart';
import { PageHeader, Panel, QueryView } from '../../components/ui';
import { get } from '../../lib/api';
import { fmtDate, formatBaht } from '../../lib/format';
import { LiveIndicator, useLivePolling } from '../../lib/realtime';
import { METHOD_LABEL } from '../../lib/settings';

function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return <span className="text-xs text-ink-3">ไม่มีข้อมูลเทียบ</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const up = pct >= 0;
  return (
    <span className={clsx('inline-flex items-center gap-0.5 text-xs', up ? 'text-basil-600' : 'text-chili')}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {Math.abs(pct)}% เทียบช่วงเวลาเดียวกันของสัปดาห์ก่อน
    </span>
  );
}

/** Owner/manager live view of today. All figures are computed from recorded transactions. */
export function DashboardPage() {
  const poll = useLivePolling();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/reports/dashboard'), refetchInterval: Math.min(poll, 30_000) });
  return (
    <>
      <PageHeader title="แดชบอร์ดวันนี้" crumbs={[{ label: 'บริหาร' }]} description={<LiveIndicator />} actions={<Link to="/reports" className="text-sm text-sky hover:underline">รายงานละเอียด</Link>} />
      <QueryView query={q}>
        {(d) => (
          <div className="flex flex-col gap-4">
            <section aria-label="ยอดวันนี้" className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
              <div className="rounded-panel border border-line bg-surface px-5 py-4">
                <div className="text-sm text-ink-2">ยอดขายวันนี้ ({fmtDate(d.today)})</div>
                <div className="num mt-1 text-4xl font-semibold tracking-tight">{formatBaht(d.now.totalSatang)}</div>
                <Delta now={d.now.totalSatang} before={d.sameDayLastWeek.totalSatang} />
              </div>
              <div className="rounded-panel border border-line bg-surface px-4 py-4">
                <div className="text-sm text-ink-2">บิล · ลูกค้า</div>
                <div className="num mt-1 text-2xl font-semibold">
                  {d.now.orders} · {d.now.guests}
                </div>
                <div className="text-xs text-ink-3">เฉลี่ย {formatBaht(d.now.avgBillSatang)} / บิล</div>
              </div>
              <div className="rounded-panel border border-line bg-surface px-4 py-4">
                <div className="text-sm text-ink-2">ตอนนี้ในร้าน</div>
                <div className="num mt-1 text-2xl font-semibold">
                  {d.live.occupiedTables}/{d.live.tables} โต๊ะ
                </div>
                <div className="text-xs text-ink-3">
                  บิลเปิด {d.live.openOrders} ({formatBaht(d.live.openAmountSatang)}) · ในครัว {d.live.itemsInKitchen} รายการ
                </div>
              </div>
            </section>
            {(d.live.pendingPayments > 0 || d.now.voids.count > 0 || d.now.refunds.count > 0) && (
              <p className="rounded-control bg-turmeric-50 px-3 py-2 text-sm text-[#7A5806]">
                {d.live.pendingPayments > 0 && `การชำระรอยืนยัน ${d.live.pendingPayments} รายการ · `}Void วันนี้ {d.now.voids.count} บิล ({formatBaht(d.now.voids.amountSatang)}) · คืนเงิน {d.now.refunds.count} รายการ ({formatBaht(d.now.refunds.amountSatang)})
              </p>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="ยอดขายตามชั่วโมง (วันนี้)">
                <BarChart
                  title="ยอดขายตามชั่วโมงวันนี้"
                  data={Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: String(h), value: d.hourly.find((x: any) => x.hour === h)?.totalSatang ?? 0 }))}
                  format={(v) => formatBaht(v)}
                  emptyText="ยังไม่มียอดขายวันนี้"
                />
              </Panel>
              <Panel title="7 วันล่าสุด">
                <BarChart title="ยอดขาย 7 วันล่าสุด" data={d.last7Days.map((x: any) => ({ key: x.date, label: x.date.slice(5), value: x.totalSatang }))} format={(v) => formatBaht(v)} />
              </Panel>
              <Panel title="เมนูขายดีวันนี้">
                <BarList items={d.topItems.map((i: any) => ({ key: i.menuItemId, label: i.name, value: i.qty }))} format={(v) => `${v} จาน`} />
              </Panel>
              <Panel title="วิธีชำระวันนี้">
                <BarList items={d.byPayment.map((p: any) => ({ key: p.method, label: METHOD_LABEL[p.method] ?? p.method, value: p.amountSatang }))} format={(v) => formatBaht(v)} />
              </Panel>
            </div>
          </div>
        )}
      </QueryView>
    </>
  );
}
