import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { toSatang } from '@shared/money';
import { useApproval } from '../../components/ApprovalDialog';
import { Badge, Button, DataTable, Dialog, EmptyState, ErrorState, Input, LoadingBlock, MoneyInput, PageHeader, Panel, QueryView, Select, Stat, Textarea, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, formatBaht } from '../../lib/format';
import { METHOD_LABEL } from '../../lib/settings';
import { CHANNEL_LABEL } from '../menu/ItemDialog';

export interface ShiftReport {
  shiftId: string;
  cashier: string | null;
  status: string;
  openedAt: string;
  closedAt: string | null;
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

const DENOMS = [100000, 50000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 25];

export function ShiftReportView({ report, kind }: { report: ShiftReport; kind: 'X' | 'Z' }) {
  const R = ({ l, v, neg }: { l: string; v: number; neg?: boolean }) => (
    <div className="flex justify-between">
      <span>{l}</span>
      <span className="num">{neg && v !== 0 ? '-' : ''}{formatBaht(v)}</span>
    </div>
  );
  return (
    <article className="flex flex-col gap-3 text-sm">
      <header>
        <h3 className="text-base font-semibold">{kind === 'X' ? 'สรุประหว่างกะ (X)' : 'สรุปปิดกะ (Z)'}</h3>
        <p className="text-ink-2">
          {report.cashier} · เปิด {fmtDateTime(report.openedAt)} {report.closedAt && `· ปิด ${fmtDateTime(report.closedAt)}`}
        </p>
      </header>
      <section>
        <h4 className="font-medium">ยอดขาย</h4>
        <R l={`บิลที่ชำระ ${report.orders.count} บิล · ${report.orders.guests} คน`} v={report.orders.grossSatang} />
        <R l="ส่วนลด" v={report.orders.discountSatang} neg />
        <R l="ค่าบริการ" v={report.orders.serviceChargeSatang} />
        <R l="ภาษีมูลค่าเพิ่ม" v={report.orders.vatSatang} />
        <div className="font-semibold">
          <R l="รวมสุทธิ" v={report.orders.totalSatang} />
        </div>
      </section>
      <section>
        <h4 className="font-medium">ตามวิธีชำระ</h4>
        {report.byMethod.length === 0 && <p className="text-ink-3">—</p>}
        {report.byMethod.map((m) => (
          <R key={m.method} l={`${METHOD_LABEL[m.method] ?? m.method} (${m.count})`} v={m.amountSatang} />
        ))}
      </section>
      <section>
        <h4 className="font-medium">ตามช่องทาง</h4>
        {report.byChannel.map((c) => (
          <R key={c.channel} l={`${CHANNEL_LABEL[c.channel] ?? c.channel} (${c.count})`} v={c.totalSatang} />
        ))}
      </section>
      <section>
        <h4 className="font-medium">ควบคุม</h4>
        <R l={`ยกเลิกบิล ${report.voids.count} บิล`} v={report.voids.amountSatang} />
        <R l={`คืนเงิน ${report.refunds.count} รายการ`} v={report.refunds.amountSatang} />
        <p>เปิดลิ้นชักโดยไม่ขาย {report.cashMovements.noSaleCount} ครั้ง</p>
        {report.pendingPayments > 0 && <p className="text-chili">มีการชำระรอยืนยัน {report.pendingPayments} รายการ</p>}
      </section>
      <section>
        <h4 className="font-medium">ลิ้นชักเงินสด</h4>
        <R l="เงินทอนตั้งต้น" v={report.openingFloatSatang} />
        <R l="รับเงินสด" v={report.byMethod.find((m) => m.method === 'CASH')?.amountSatang ?? 0} />
        <R l="นำเงินเข้า" v={report.cashMovements.payInSatang} />
        <R l="นำเงินออก" v={report.cashMovements.payOutSatang} neg />
        <R l="คืนเงินสด" v={report.refunds.cashSatang} neg />
        <div className="font-semibold">
          <R l="เงินสดที่ควรมี" v={report.expectedCashSatang} />
        </div>
        {report.countedCashSatang != null && (
          <>
            <R l="นับได้จริง" v={report.countedCashSatang} />
            <div className={report.varianceSatang === 0 ? 'text-basil-600' : 'font-semibold text-chili'}>
              <R l="ส่วนต่าง" v={report.varianceSatang ?? 0} />
            </div>
          </>
        )}
      </section>
    </article>
  );
}

function CashDialog({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<'PAY_IN' | 'PAY_OUT' | 'NO_SALE'>('PAY_OUT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const approval = useApproval(type === 'NO_SALE' ? 'cash.open_drawer' : 'cash.pay_in_out');
  const save = useMutation({
    mutationFn: (appr: { userId: string; pin: string } | null) => post(`/shifts/${shiftId}/cash`, { type, amountSatang: type === 'NO_SALE' ? 0 : toSatang(amount || '0'), reason, approval: appr }),
    onSuccess: () => {
      toast.success('บันทึกแล้ว');
      qc.invalidateQueries({ queryKey: ['shift-current'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="ลิ้นชักเงินสด"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} disabled={reason.trim().length < 3 || (type !== 'NO_SALE' && !amount)} onClick={() => approval.request((a) => save.mutateAsync(a))}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Select label="รายการ" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="PAY_OUT">นำเงินออก (Pay out)</option>
          <option value="PAY_IN">นำเงินเข้า (Pay in)</option>
          <option value="NO_SALE">เปิดลิ้นชักโดยไม่มีการขาย</option>
        </Select>
        {type !== 'NO_SALE' && <MoneyInput label="จำนวนเงิน" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        <Textarea label="เหตุผล" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น ซื้อน้ำแข็ง, แลกเหรียญ" />
      </div>
      {approval.dialog}
    </Dialog>
  );
}

function CloseDialog({ shiftId, report, onClose }: { shiftId: string; report: ShiftReport; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [z, setZ] = useState<ShiftReport | null>(null);
  const counted = DENOMS.reduce((a, d) => a + d * (counts[d] ?? 0), 0);
  const close = useMutation({
    mutationFn: () => post<{ report: ShiftReport }>(`/shifts/${shiftId}/close`, { countedCashSatang: counted, countDetail: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)), note: note || undefined }),
    onSuccess: (r) => {
      setZ(r.report);
      qc.invalidateQueries({ queryKey: ['shift-current'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      toast.success('ปิดกะแล้ว');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (z)
    return (
      <Dialog
        open
        onClose={onClose}
        title="สรุปปิดกะ (Z)"
        footer={
          <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
            พิมพ์
          </Button>
        }
      >
        <ShiftReportView report={z} kind="Z" />
      </Dialog>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title="ปิดกะ — นับเงินสด"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={close.isPending} onClick={() => close.mutate()}>
            ปิดกะ
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-2">นับเงินในลิ้นชักตามชนิด ระบบจะเทียบกับยอดที่ควรมีหลังปิดกะ (ไม่แสดงยอดที่ควรมีก่อนนับ เพื่อป้องกันการปรับตัวเลข)</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {DENOMS.map((d) => (
          <Input
            key={d}
            label={formatBaht(d)}
            type="number"
            min={0}
            inputMode="numeric"
            value={counts[d] ?? ''}
            onChange={(e) => setCounts({ ...counts, [d]: Math.max(0, Number(e.target.value) || 0) })}
          />
        ))}
      </div>
      <p className="num mt-3 text-xl font-semibold">นับได้ {formatBaht(counted)}</p>
      {report.pendingPayments > 0 && <p className="text-chili">ต้องยืนยันหรือยกเลิกการชำระที่รอยืนยันก่อน ({report.pendingPayments})</p>}
      <Textarea label="หมายเหตุ" value={note} onChange={(e) => setNote(e.target.value)} wrapClassName="mt-3" />
    </Dialog>
  );
}

export function ShiftPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const current = useQuery({ queryKey: ['shift-current'], queryFn: () => get<{ shift: { id: string; openingFloatSatang: number; openedAt: string } | null; report: ShiftReport | null }>('/shifts/current'), refetchInterval: 30_000 });
  const history = useQuery({ queryKey: ['shifts'], queryFn: () => get<{ shifts: { id: string; cashier: string; status: string; openedAt: string; closedAt: string | null; varianceSatang: number | null; openingFloatSatang: number }[] }>('/shifts') });
  const [float, setFloat] = useState('1000.00');
  const [cash, setCash] = useState(false);
  const [closing, setClosing] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const viewReport = useQuery({ queryKey: ['shift-report', viewing], queryFn: () => get<{ kind: 'X' | 'Z'; report: ShiftReport }>(`/shifts/${viewing}/report`), enabled: !!viewing });
  const open = useMutation({
    mutationFn: () => post('/shifts/open', { openingFloatSatang: toSatang(float || '0') }),
    onSuccess: () => {
      toast.success('เปิดกะแล้ว');
      qc.invalidateQueries({ queryKey: ['shift-current'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="กะและลิ้นชักเงิน" crumbs={[{ label: 'หน้าร้าน' }]} />
      <QueryView query={current}>
        {(d) =>
          !d.shift ? (
            <Panel title="เปิดกะ" className="max-w-md">
              <form
                className="flex items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  open.mutate();
                }}
              >
                <MoneyInput label="เงินทอนตั้งต้น" value={float} onChange={(e) => setFloat(e.target.value)} wrapClassName="flex-1" />
                <Button type="submit" loading={open.isPending} disabled={!can('shift.open')}>
                  เปิดกะ
                </Button>
              </form>
            </Panel>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="ยอดขายกะนี้" value={formatBaht(d.report!.orders.totalSatang)} hint={`${d.report!.orders.count} บิล`} />
                  <Stat label="เงินสดรับ" value={formatBaht(d.report!.byMethod.find((m) => m.method === 'CASH')?.amountSatang ?? 0)} />
                  <Stat label="ยกเลิกบิล" value={d.report!.voids.count} />
                  <Stat label="คืนเงิน" value={formatBaht(d.report!.refunds.amountSatang)} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setCash(true)}>
                    นำเงินเข้า/ออก
                  </Button>
                  <Button variant="outline" icon={<Printer className="size-4" />} onClick={() => setViewing(d.shift!.id)}>
                    สรุประหว่างกะ (X)
                  </Button>
                  {can('shift.close') && (
                    <Button variant="danger" onClick={() => setClosing(true)}>
                      ปิดกะ
                    </Button>
                  )}
                </div>
              </div>
              <Panel title="สรุประหว่างกะ">
                <ShiftReportView report={d.report!} kind="X" />
              </Panel>
              {cash && <CashDialog shiftId={d.shift.id} onClose={() => setCash(false)} />}
              {closing && <CloseDialog shiftId={d.shift.id} report={d.report!} onClose={() => setClosing(false)} />}
            </div>
          )
        }
      </QueryView>
      <h2 className="mt-8 mb-3 text-lg font-semibold">ประวัติกะ</h2>
      <QueryView query={history} isEmpty={(h) => h.shifts.length === 0} empty={<EmptyState title="ยังไม่มีประวัติกะ" />}>
        {(h) => (
          <DataTable
            rows={h.shifts}
            rowKey={(r) => r.id}
            onRowClick={(r) => setViewing(r.id)}
            columns={[
              { key: 'cashier', header: 'แคชเชียร์', cell: (r) => r.cashier },
              { key: 'open', header: 'เปิด', cell: (r) => fmtDateTime(r.openedAt) },
              { key: 'close', header: 'ปิด', cell: (r) => fmtDateTime(r.closedAt) },
              { key: 'status', header: 'สถานะ', cell: (r) => (r.status === 'OPEN' ? <Badge tone="info">เปิดอยู่</Badge> : <Badge>ปิดแล้ว</Badge>) },
              {
                key: 'var',
                header: 'ส่วนต่างเงินสด',
                align: 'right',
                cell: (r) => (r.varianceSatang == null ? '—' : <span className={r.varianceSatang === 0 ? '' : 'text-chili'}>{formatBaht(r.varianceSatang)}</span>),
              },
            ]}
          />
        )}
      </QueryView>
      {viewing && (
        <Dialog
          open
          onClose={() => setViewing(null)}
          title={!viewReport.data ? 'สรุปกะ' : viewReport.data.kind === 'X' ? 'สรุประหว่างกะ (X)' : 'สรุปปิดกะ (Z)'}
          footer={
            viewReport.data && (
              <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
                พิมพ์
              </Button>
            )
          }
        >
          {viewReport.data ? (
            <ShiftReportView report={viewReport.data.report} kind={viewReport.data.kind} />
          ) : viewReport.error ? (
            <ErrorState error={viewReport.error} onRetry={() => viewReport.refetch()} />
          ) : (
            <LoadingBlock />
          )}
        </Dialog>
      )}
    </>
  );
}
