import { useQuery } from '@tanstack/react-query';
import { Download, Info, Printer } from 'lucide-react';
import { useState } from 'react';
import { BarChart, BarList } from '../../components/BarChart';
import { Badge, Button, DataTable, Dialog, EmptyState, Input, PageHeader, Panel, QueryView, Select, Stat, StatusBadge, Tabs, useToast } from '../../components/ui';
import { ApiError, errorMessage, get, qs } from '../../lib/api';
import { useTabParam } from '../../lib/useTabParam';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtTime, formatBaht, todayISO } from '../../lib/format';
import { METHOD_LABEL } from '../../lib/settings';
import { CHANNEL_LABEL } from '../menu/ItemDialog';

type Tab = 'sales' | 'items' | 'costs' | 'staff' | 'tax';

const CLASS_LABEL: Record<string, [string, 'success' | 'info' | 'warning' | 'danger']> = {
  STAR: ['ขายดี กำไรดี', 'success'],
  PLOWHORSE: ['ขายดี กำไรน้อย', 'info'],
  PUZZLE: ['กำไรดี ขายน้อย', 'warning'],
  DOG: ['ขายน้อย กำไรน้อย', 'danger'],
};

function addDaysISO(d: string, n: number) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function Definition({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 flex gap-1.5 text-xs text-ink-3">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function DayOrders({ params, date, onClose }: { params: string; date: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['report-orders', params, date], queryFn: () => get<{ orders: any[] }>(`/reports/orders?${params.replace(/from=[^&]+&to=[^&]+/, `from=${date}&to=${date}`)}`) });
  return (
    <Dialog open onClose={onClose} title={`บิลวันที่ ${fmtDate(date)}`} size="xl">
      <QueryView query={q} isEmpty={(d) => d.orders.length === 0} empty={<EmptyState title="ไม่มีบิล" />}>
        {(d) => (
          <DataTable
            rows={d.orders}
            rowKey={(r) => r.id}
            columns={[
              { key: 'n', header: 'บิล', cell: (r) => `#${r.orderNo}` },
              { key: 'r', header: 'ใบเสร็จ', cell: (r) => r.receiptNo ?? '—' },
              { key: 't', header: 'เวลา', cell: (r) => fmtTime(r.paidAt) },
              { key: 'c', header: 'ช่องทาง', cell: (r) => (r.tableName ? `โต๊ะ ${r.tableName}` : (CHANNEL_LABEL[r.channel] ?? r.channel)) },
              { key: 's', header: 'สถานะ', cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'd', header: 'ส่วนลด', align: 'right', cell: (r) => (r.discountSatang ? formatBaht(r.discountSatang) : '—') },
              { key: 'g', header: 'ยอด', align: 'right', cell: (r) => formatBaht(r.grandTotalSatang) },
            ]}
          />
        )}
      </QueryView>
    </Dialog>
  );
}

function SalesTab({ params }: { params: string }) {
  const q = useQuery({ queryKey: ['report', 'sales', params], queryFn: () => get<any>(`/reports/sales?${params}`) });
  const [day, setDay] = useState<string | null>(null);
  return (
    <QueryView query={q}>
      {(r) =>
        r.totals.orders === 0 && r.totals.voids.count === 0 ? (
          <EmptyState title="ยังไม่มียอดขายในช่วงนี้" />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="ยอดขายรวม" value={formatBaht(r.totals.totalSatang)} hint={`${r.totals.orders} บิล`} />
              <Stat label="ยอดขายสุทธิ" value={formatBaht(r.totals.netSatang)} hint="หลังส่วนลด ก่อนค่าบริการ/VAT" />
              <Stat label="เฉลี่ยต่อบิล" value={formatBaht(r.totals.avgBillSatang)} />
              <Stat label="เฉลี่ยต่อคน" value={formatBaht(r.totals.avgPerGuestSatang)} hint={`${r.totals.guests} คน`} />
              <Stat label="ส่วนลด" value={formatBaht(r.totals.discountSatang)} />
              <Stat label="ค่าบริการ / VAT" value={`${formatBaht(r.totals.serviceChargeSatang)} / ${formatBaht(r.totals.vatSatang)}`} />
              <Stat label="คืนเงิน" value={formatBaht(r.totals.refunds.amountSatang)} hint={`${r.totals.refunds.count} รายการ (ตามวันที่คืน)`} />
              <Stat label="ยกเลิกบิล" value={formatBaht(r.totals.voids.amountSatang)} hint={`${r.totals.voids.count} บิล`} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="ยอดขายรายวัน">
                <BarChart title="ยอดขายรายวัน" data={r.daily.map((d: any) => ({ key: d.date, label: d.date.slice(5), value: d.totalSatang }))} format={(v) => formatBaht(v)} />
                <ul className="mt-2 flex flex-wrap gap-1">
                  {r.daily.map((d: any) => (
                    <li key={d.date}>
                      <button type="button" className="min-h-9 rounded border border-line px-2 text-xs hover:bg-sunken pointer-coarse:min-h-11" onClick={() => setDay(d.date)}>
                        {fmtDate(d.date)}
                      </button>
                    </li>
                  ))}
                </ul>
                <Definition>แตะวันที่เพื่อดูบิลที่ประกอบเป็นยอดนั้น · ยอดขาย = บิลที่ชำระแล้ว ตามวันทำการของสาขา</Definition>
              </Panel>
              <Panel title="ยอดขายตามชั่วโมง">
                <BarChart
                  title="ยอดขายตามชั่วโมง"
                  data={Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: `${h}`, value: r.hourly.find((x: any) => x.hour === h)?.totalSatang ?? 0 }))}
                  format={(v) => formatBaht(v)}
                />
                <Definition>ใช้เวลาที่ชำระเงินตามเขตเวลาของสาขา</Definition>
              </Panel>
              <Panel title="ตามช่องทาง">
                <BarList items={r.byChannel.map((c: any) => ({ key: c.channel, label: CHANNEL_LABEL[c.channel] ?? c.channel, sub: `${c.orders} บิล`, value: c.totalSatang }))} format={(v) => formatBaht(v)} />
              </Panel>
              <Panel title="ตามวิธีชำระ">
                <BarList items={r.byPayment.map((p: any) => ({ key: p.method, label: METHOD_LABEL[p.method] ?? p.method, sub: `${p.count} รายการ`, value: p.amountSatang }))} format={(v) => formatBaht(v)} />
                <Definition>ยอดรับจริงต่อวิธีชำระหลังหักเงินคืน — บิลที่จ่ายหลายวิธีถูกนับแยกตามวิธี ไม่นับซ้ำ</Definition>
              </Panel>
              <Panel title="โต๊ะและลูกค้า">
                <dl className="grid grid-cols-2 gap-y-1 text-sm">
                  <dt className="text-ink-2">บิลทานที่ร้าน</dt>
                  <dd className="num text-right">{r.tables.dineInOrders}</dd>
                  <dt className="text-ink-2">รอบต่อโต๊ะต่อวัน</dt>
                  <dd className="num text-right">{r.tables.turnsPerTablePerDay ?? '—'}</dd>
                  <dt className="text-ink-2">เวลานั่งเฉลี่ย</dt>
                  <dd className="num text-right">{r.tables.avgSeatingMinutes} นาที</dd>
                  <dt className="text-ink-2">บิลที่มีสมาชิก</dt>
                  <dd className="num text-right">
                    {r.customers.memberOrders}/{r.customers.totalOrders}
                  </dd>
                  <dt className="text-ink-2">สมาชิกใหม่ / กลับมาซ้ำ</dt>
                  <dd className="num text-right">
                    {r.customers.newMembers} / {r.customers.returningMembers}
                  </dd>
                </dl>
                <Definition>รอบต่อโต๊ะ = บิลทานที่ร้าน ÷ จำนวนโต๊ะ ÷ จำนวนวัน · ลูกค้าใหม่/ประจำนับเฉพาะลูกค้าที่ผูกสมาชิก</Definition>
              </Panel>
            </div>
            {day && <DayOrders params={params} date={day} onClose={() => setDay(null)} />}
          </div>
        )
      }
    </QueryView>
  );
}

function ItemsTab({ params }: { params: string }) {
  const q = useQuery({ queryKey: ['report', 'items', params], queryFn: () => get<any>(`/reports/items?${params}`) });
  return (
    <QueryView query={q} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="ยังไม่มีการขายในช่วงนี้" />}>
      {(r) => (
        <>
          <DataTable
            rows={r.items}
            rowKey={(x: any) => x.menuItemId}
            columns={[
              { key: 'n', header: 'เมนู', cell: (x: any) => x.name },
              { key: 'q', header: 'จำนวน', align: 'right', cell: (x: any) => x.qty },
              { key: 'm', header: 'สัดส่วน', align: 'right', cell: (x: any) => `${x.mixPct}%` },
              { key: 'r', header: 'ยอดขาย', align: 'right', cell: (x: any) => formatBaht(x.revenueSatang) },
              ...(r.withCost
                ? [
                    { key: 'c', header: 'ต้นทุน', align: 'right' as const, cell: (x: any) => (x.costSatang === null ? <span className="text-ink-3">ไม่มีสูตร</span> : formatBaht(x.costSatang)) },
                    { key: 'g', header: 'กำไรขั้นต้น', align: 'right' as const, cell: (x: any) => (x.marginSatang === null ? '—' : formatBaht(x.marginSatang)) },
                    { key: 'f', header: 'ต้นทุนวัตถุดิบ %', align: 'right' as const, cell: (x: any) => (x.foodCostPct === null ? '—' : `${x.foodCostPct}%`) },
                    { key: 'e', header: 'กลุ่มเมนู', cell: (x: any) => (x.menuClass ? <Badge tone={CLASS_LABEL[x.menuClass][1]}>{CLASS_LABEL[x.menuClass][0]}</Badge> : '—') },
                  ]
                : []),
            ]}
          />
          <Definition>
            ยอดขายต่อเมนู = ยอดรายการหลังส่วนลดรายการ (ก่อนส่วนลดทั้งบิล/ค่าบริการ/VAT) · ต้นทุน = ต้นทุนวัตถุดิบตามสูตรที่ตัดสต็อกจริงตอนส่งครัว · Menu engineering คำนวณเฉพาะเมนูที่มีสูตร (เกณฑ์ขายดี = 70% ของสัดส่วนเฉลี่ย, กำไรดี = กำไรต่อจานเฉลี่ย)
          </Definition>
        </>
      )}
    </QueryView>
  );
}

function CostsTab({ params }: { params: string }) {
  const q = useQuery({ queryKey: ['report', 'costs', params], queryFn: () => get<any>(`/reports/costs?${params}`) });
  return (
    <QueryView query={q}>
      {(r) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="ต้นทุนวัตถุดิบ %" value={r.foodCostPct === null ? '—' : `${r.foodCostPct}%`} hint={`ต้นทุนขาย ${formatBaht(r.cogsSatang)}`} />
            <Stat label="ของเสีย" value={formatBaht(r.wasteSatang)} />
            <Stat label="ส่วนต่างสต็อก (นับ/ปรับ)" value={formatBaht(r.varianceSatang)} />
            <Stat label="ต้นทุนค่าแรง %" value={r.laborCostPct === null ? '—' : `${r.laborCostPct}%`} hint={r.labor.available ? formatBaht(r.labor.costSatang) : r.labor.note} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="ของเสียตามวัตถุดิบ">
              {r.waste.length === 0 ? <p className="text-sm text-ink-3">ไม่มี</p> : <BarList items={r.waste.map((w: any) => ({ key: w.name, label: w.name, sub: `${w.qty} ${w.unit}`, value: w.valueSatang }))} format={(v) => formatBaht(v)} />}
            </Panel>
            <Panel title="ส่วนต่างจากการนับ/ปรับยอด">
              {r.variance.length === 0 ? (
                <p className="text-sm text-ink-3">ไม่มี</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {r.variance.map((w: any) => (
                    <li key={w.name} className="flex justify-between">
                      <span>{w.name}</span>
                      <span className={`num ${w.valueSatang < 0 ? 'text-chili' : ''}`}>
                        {w.qty} {w.unit} · {formatBaht(w.valueSatang)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          <Definition>ต้นทุนวัตถุดิบ % = ต้นทุนวัตถุดิบที่ตัดจากการขาย ÷ ยอดขายสุทธิ (เฉพาะเมนูที่มีสูตร — ถ้าบางเมนูยังไม่มีสูตร ตัวเลขจะต่ำกว่าความจริง) · ซื้อเข้าในช่วงนี้ {formatBaht(r.purchasesSatang)}</Definition>
        </div>
      )}
    </QueryView>
  );
}

function StaffTab({ params }: { params: string }) {
  const q = useQuery({ queryKey: ['report', 'staff', params], queryFn: () => get<any>(`/reports/staff?${params}`) });
  const T = ({ title, rows, cols }: { title: string; rows: any[]; cols: any[] }) => (
    <Panel title={title}>{rows.length === 0 ? <p className="text-sm text-ink-3">ไม่มี</p> : <DataTable rows={rows} rowKey={(x: any) => JSON.stringify(x)} columns={cols} />}</Panel>
  );
  const money = { key: 'a', header: 'มูลค่า', align: 'right' as const, cell: (x: any) => formatBaht(x.amountSatang) };
  return (
    <QueryView query={q}>
      {(r) => (
        <div className="grid gap-4 lg:grid-cols-2">
          <T title="ยอดขายตามพนักงานที่เปิดบิล" rows={r.salesByStaff} cols={[{ key: 'n', header: 'พนักงาน', cell: (x: any) => x.name ?? '—' }, { key: 'o', header: 'บิล', align: 'right', cell: (x: any) => x.orders }, { key: 't', header: 'ยอด', align: 'right', cell: (x: any) => formatBaht(x.totalSatang) }]} />
          <T title="บิลที่ถูกยกเลิก" rows={r.voids} cols={[{ key: 'n', header: 'ผู้ยกเลิก', cell: (x: any) => x.name ?? '—' }, { key: 'c', header: 'จำนวน', align: 'right', cell: (x: any) => x.count }, money]} />
          <T title="ยกเลิกรายการหลังส่งครัว" rows={r.cancelledItems} cols={[{ key: 'n', header: 'ผู้ยกเลิก', cell: (x: any) => x.name ?? '—' }, { key: 'c', header: 'จำนวน', align: 'right', cell: (x: any) => x.count }, money]} />
          <T
            title="ส่วนลด"
            rows={r.discounts}
            cols={[
              { key: 'g', header: 'ผู้ให้', cell: (x: any) => x.givenBy ?? '—' },
              { key: 'a2', header: 'ผู้อนุมัติ', cell: (x: any) => x.approvedBy ?? '—' },
              { key: 'p', header: '', cell: (x: any) => (x.promotion ? <Badge>โปรโมชัน</Badge> : null) },
              { key: 'c', header: 'ครั้ง', align: 'right', cell: (x: any) => x.count },
              money,
            ]}
          />
          <T title="คืนเงิน" rows={r.refunds} cols={[{ key: 'n', header: 'ผู้ทำ', cell: (x: any) => x.name ?? '—' }, { key: 'ap', header: 'ผู้อนุมัติ', cell: (x: any) => x.approvedBy ?? '—' }, { key: 'c', header: 'ครั้ง', align: 'right', cell: (x: any) => x.count }, money]} />
          <T
            title="ส่วนต่างเงินสดปิดกะ"
            rows={r.cashVariance}
            cols={[
              { key: 'd', header: 'วันที่', cell: (x: any) => fmtDate(x.date) },
              { key: 'n', header: 'แคชเชียร์', cell: (x: any) => x.name },
              { key: 'e', header: 'ควรมี', align: 'right', cell: (x: any) => formatBaht(x.expectedSatang) },
              { key: 'c', header: 'นับได้', align: 'right', cell: (x: any) => formatBaht(x.countedSatang) },
              { key: 'v', header: 'ส่วนต่าง', align: 'right', cell: (x: any) => <span className={x.varianceSatang ? 'text-chili' : ''}>{formatBaht(x.varianceSatang)}</span> },
            ]}
          />
        </div>
      )}
    </QueryView>
  );
}

function TaxTab({ params }: { params: string }) {
  const q = useQuery({ queryKey: ['report', 'tax', params], queryFn: () => get<any>(`/reports/tax?${params}`) });
  return (
    <QueryView query={q}>
      {(r) => (
        <div className="flex flex-col gap-4">
          <p className="rounded-control bg-turmeric-50 px-3 py-2 text-sm text-turmeric-700">{r.disclaimer}</p>
          <DataTable
            rows={r.days}
            rowKey={(x: any) => x.date}
            columns={[
              { key: 'd', header: 'วันที่', cell: (x: any) => fmtDate(x.date) },
              { key: 'n', header: 'ใบเสร็จ', align: 'right', cell: (x: any) => x.receipts },
              { key: 'r', header: 'เลขที่', cell: (x: any) => (x.firstNo ? `${x.firstNo} – ${x.lastNo}` : '—') },
              { key: 'b', header: 'มูลค่าก่อนภาษี', align: 'right', cell: (x: any) => formatBaht(x.taxableBaseSatang) },
              { key: 'v', header: 'ภาษีขาย', align: 'right', cell: (x: any) => formatBaht(x.vatSatang) },
              { key: 't', header: 'รวม', align: 'right', cell: (x: any) => formatBaht(x.totalSatang) },
            ]}
          />
          <Panel title="ใบกำกับภาษีเต็มรูปที่ออก">
            {r.fullTaxInvoices.length === 0 ? (
              <p className="text-sm text-ink-3">ไม่มี</p>
            ) : (
              <DataTable
                rows={r.fullTaxInvoices}
                rowKey={(x: any) => x.invoiceNo}
                columns={[
                  { key: 'n', header: 'เลขที่', cell: (x: any) => x.invoiceNo },
                  { key: 'b', header: 'ผู้ซื้อ', cell: (x: any) => x.buyerName },
                  { key: 't', header: 'เลขผู้เสียภาษี', cell: (x: any) => x.buyerTaxId },
                  { key: 'v', header: 'VAT', align: 'right', cell: (x: any) => formatBaht(x.vatSatang) },
                  { key: 'g', header: 'รวม', align: 'right', cell: (x: any) => formatBaht(x.totalSatang) },
                ]}
              />
            )}
          </Panel>
        </div>
      )}
    </QueryView>
  );
}

export function ReportsPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState(addDaysISO(todayISO(), -6));
  const [to, setTo] = useState(todayISO());
  const [branches, setBranches] = useState('current');
  const [tab, setTab] = useTabParam<Tab>('sales');
  const params = qs({ from, to, branches }).slice(1);
  const exportName: Partial<Record<Tab, string>> = { sales: 'daily', items: 'items', costs: 'costs', staff: 'staff', tax: 'tax' };
  const download = async () => {
    try {
      const res = await fetch(`/api/reports/export?report=${exportName[tab]}&${params}`, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(res.status, 'EXPORT', (await res.json().catch(() => null))?.error?.message ?? 'ส่งออกไม่สำเร็จ');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${exportName[tab]}-${from}-${to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const tabs: { value: Tab; label: string }[] = [
    { value: 'sales', label: 'ยอดขาย' },
    { value: 'items', label: 'เมนู' },
    ...(can('report.view_profit') ? [{ value: 'costs' as Tab, label: 'ต้นทุน' }] : []),
    ...(can('report.view_staff') ? [{ value: 'staff' as Tab, label: 'ควบคุม/พนักงาน' }] : []),
    { value: 'tax', label: 'ภาษีขาย' },
  ];
  return (
    <>
      <PageHeader
        title="รายงาน"
        crumbs={[{ label: 'บริหาร' }]}
        actions={
          <>
            {can('report.export') && (
              <Button variant="outline" icon={<Download className="size-4" />} onClick={download}>
                CSV / Excel
              </Button>
            )}
            <Button variant="outline" icon={<Printer className="size-4" />} onClick={() => window.print()}>
              พิมพ์ / PDF
            </Button>
          </>
        }
      />
      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        <Input label="จาก" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} wrapClassName="w-40" />
        <Input label="ถึง" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} wrapClassName="w-40" />
        {[
          ['วันนี้', 0, 0],
          ['7 วัน', -6, 0],
          ['30 วัน', -29, 0],
        ].map(([l, f, t]) => (
          <Button key={l as string} size="sm" variant="ghost" onClick={() => (setFrom(addDaysISO(todayISO(), f as number)), setTo(addDaysISO(todayISO(), t as number)))}>
            {l}
          </Button>
        ))}
        {(me?.branches.length ?? 0) > 1 && (
          <Select label="สาขา" value={branches} onChange={(e) => setBranches(e.target.value)} wrapClassName="w-48">
            <option value="current">สาขาปัจจุบัน</option>
            <option value="all">ทุกสาขาที่มีสิทธิ์</option>
            {me?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {tab === 'sales' && <SalesTab params={params} />}
      {tab === 'items' && <ItemsTab params={params} />}
      {tab === 'costs' && <CostsTab params={params} />}
      {tab === 'staff' && <StaffTab params={params} />}
      {tab === 'tax' && <TaxTab params={params} />}
    </>
  );
}
