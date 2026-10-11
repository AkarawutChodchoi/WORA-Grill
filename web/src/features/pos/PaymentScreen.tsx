import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, CheckCircle2, Percent, Printer, QrCode, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { allocate, toSatang } from '@shared/money';
import { useApproval } from '../../components/ApprovalDialog';
import { Badge, Button, Dialog, ErrorState, Input, LoadingBlock, MoneyInput, Panel, Select, StatusBadge, Textarea, useToast } from '../../components/ui';
import { del, errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatBaht, fmtTime } from '../../lib/format';
import { METHOD_LABEL, useBranchSettings } from '../../lib/settings';
import { useOrder } from './OrderScreen';
import { TotalsBlock } from './Ticket';
import type { Order, Payment } from './types';

function parseBaht(v: string): number | null {
  try {
    const n = toSatang(v || '0');
    return n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function DiscountDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [scope, setScope] = useState<'BILL' | 'ITEM'>('BILL');
  const [itemId, setItemId] = useState(order.items.find((i) => i.status !== 'CANCELLED')?.id ?? '');
  const [type, setType] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState('10');
  const [reason, setReason] = useState('');
  const approval = useApproval('bill.discount');
  const override = useApproval('bill.discount_override');
  const apply = useMutation({
    mutationFn: (appr: { userId: string; pin: string } | null) => {
      const v = type === 'PERCENT' ? Math.round(Number(value) * 100) : parseBaht(value);
      if (!v || v <= 0 || (type === 'PERCENT' && v > 10000)) throw new Error('จำนวนส่วนลดไม่ถูกต้อง');
      return post<Order>(`/orders/${order.id}/discounts`, { scope, orderItemId: scope === 'ITEM' ? itemId : undefined, type, value: v, reason, approval: appr });
    },
    onSuccess: (o) => {
      qc.setQueryData(['order', order.id], o);
      toast.success('ให้ส่วนลดแล้ว');
      onClose();
    },
    onError: (e) => {
      // Above the cashier ceiling the server asks for an override approval.
      if (errorMessage(e).includes('ผู้จัดการ')) override.request((a) => apply.mutate(a));
      else toast.error(errorMessage(e));
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="ส่วนลด"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={apply.isPending} disabled={reason.trim().length < 3} onClick={() => approval.request((a) => apply.mutate(a))}>
            ให้ส่วนลด
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Select label="ลดที่" value={scope} onChange={(e) => setScope(e.target.value as 'BILL' | 'ITEM')}>
          <option value="BILL">ทั้งบิล</option>
          <option value="ITEM">เฉพาะรายการ</option>
        </Select>
        {scope === 'ITEM' && (
          <Select label="รายการ" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            {order.items
              .filter((i) => i.status !== 'CANCELLED')
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.qty}× {i.nameSnapshot} ({formatBaht(i.unitPriceSatang * i.qty)})
                </option>
              ))}
          </Select>
        )}
        <div className="flex gap-2">
          <Select label="ประเภท" value={type} onChange={(e) => setType(e.target.value as 'PERCENT' | 'AMOUNT')} wrapClassName="w-36">
            <option value="PERCENT">เปอร์เซ็นต์</option>
            <option value="AMOUNT">จำนวนเงิน</option>
          </Select>
          <Input label={type === 'PERCENT' ? '%' : 'บาท'} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} wrapClassName="flex-1" />
        </div>
        <Textarea label="เหตุผล" required value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {approval.dialog}
      {override.dialog}
    </Dialog>
  );
}

function RefundDialog({ order, payment, onClose }: { order: Order; payment: Payment; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const max = payment.amountSatang - payment.refundedSatang;
  const [amount, setAmount] = useState((max / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const approval = useApproval('payment.refund');
  const refund = useMutation({
    mutationFn: (appr: { userId: string; pin: string } | null) => post<Order>(`/payments/${payment.id}/refund`, { amountSatang: parseBaht(amount), reason, approval: appr }),
    onSuccess: (o) => {
      qc.setQueryData(['order', order.id], o);
      toast.success('บันทึกการคืนเงินแล้ว');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const amt = parseBaht(amount);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`คืนเงิน (${METHOD_LABEL[payment.method]})`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button variant="danger" loading={refund.isPending} disabled={!amt || amt > max || reason.trim().length < 3} onClick={() => approval.request((a) => refund.mutate(a))}>
            คืนเงิน
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <MoneyInput label={`จำนวน (สูงสุด ${formatBaht(max)})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Textarea label="เหตุผล" required value={reason} onChange={(e) => setReason(e.target.value)} />
        {payment.method !== 'CASH' && <p className="text-sm text-ink-2">ระบบบันทึกการคืนเงินเท่านั้น การโอน/คืนเงินบัตรต้องทำที่ธนาคารหรือเครื่อง EDC</p>}
      </div>
      {approval.dialog}
    </Dialog>
  );
}

function TaxInvoiceDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ buyerName: '', buyerTaxId: '', buyerAddress: '', buyerBranch: 'สำนักงานใหญ่' });
  const issue = useMutation({
    mutationFn: () => post(`/orders/${order.id}/tax-invoice`, f),
    onSuccess: () => {
      toast.success('ออกใบกำกับภาษีเต็มรูปแล้ว');
      nav(`/pos/orders/${order.id}/receipt?doc=tax`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="ใบกำกับภาษีเต็มรูป"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={issue.isPending} onClick={() => issue.mutate()}>
            ออกใบกำกับภาษี
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Input label="ชื่อผู้ซื้อ/บริษัท" required value={f.buyerName} onChange={(e) => setF({ ...f, buyerName: e.target.value })} />
        <Input label="เลขประจำตัวผู้เสียภาษี (13 หลัก)" required inputMode="numeric" value={f.buyerTaxId} onChange={(e) => setF({ ...f, buyerTaxId: e.target.value.replace(/\D/g, '').slice(0, 13) })} />
        <Input label="สาขา" value={f.buyerBranch} onChange={(e) => setF({ ...f, buyerBranch: e.target.value })} />
        <Textarea label="ที่อยู่" required value={f.buyerAddress} onChange={(e) => setF({ ...f, buyerAddress: e.target.value })} />
      </div>
    </Dialog>
  );
}

export function PaymentScreen() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const order = useOrder(id);
  const settings = useBranchSettings();
  const shift = useQuery({ queryKey: ['shift-current'], queryFn: () => get<{ shift: { id: string } | null }>('/shifts/current') });
  const [method, setMethod] = useState('CASH');
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [split, setSplit] = useState(1);
  const [qr, setQr] = useState<{ dataUrl: string; amount: number } | null>(null);
  const [confirmRef, setConfirmRef] = useState<Record<string, string>>({});
  const [discountOpen, setDiscountOpen] = useState(false);
  const [refund, setRefund] = useState<Payment | null>(null);
  const [taxOpen, setTaxOpen] = useState(false);

  const pay = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<Order>(`/orders/${id}/payments`, { id: crypto.randomUUID(), ...body }),
    onSuccess: (o) => {
      qc.setQueryData(['order', id], o);
      qc.invalidateQueries({ queryKey: ['tables'] });
      setAmount('');
      setTendered('');
      setReference('');
      if (o.status === 'PAID') toast.success('ชำระเงินครบแล้ว');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const act = useMutation({
    mutationFn: (fn: () => Promise<Order>) => fn(),
    onSuccess: (o) => {
      qc.setQueryData(['order', id], o);
      qc.invalidateQueries({ queryKey: ['tables'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (order.isLoading || settings.isLoading) return <div className="p-6"><LoadingBlock /></div>;
  if (order.error || !order.data) return <div className="p-6"><ErrorState error={order.error} onRetry={() => order.refetch()} /></div>;
  const o = order.data;
  const payments = o.payments ?? [];
  const pending = payments.filter((p) => p.status === 'PENDING_CONFIRMATION').reduce((a, p) => a + p.amountSatang, 0);
  const due = Math.max(0, o.grandTotalSatang - o.paidSatang - pending);
  const share = split > 1 ? allocate(due, Array(split).fill(1))[0] : due;
  const methods = settings.data?.settings.enabledPaymentMethods ?? ['CASH'];
  const amt = amount ? parseBaht(amount) : share;
  const tend = tendered ? parseBaht(tendered) : null;
  const change = method === 'CASH' && tend != null && amt != null ? tend - amt : 0;
  const payable = ['OPEN', 'BILL_REQUESTED'].includes(o.status);
  const noShift = !shift.data?.shift;

  const submit = () => {
    if (amt == null || amt <= 0) return toast.error('จำนวนเงินไม่ถูกต้อง');
    if (method === 'CASH' && tend != null && tend < amt) return toast.error('รับเงินมาไม่พอ');
    pay.mutate({ method, amountSatang: amt, tenderedSatang: method === 'CASH' ? (tend ?? amt) : undefined, reference: reference || undefined });
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-4 p-3 sm:p-5">
      <header className="no-print flex flex-wrap items-center gap-3">
        <Button variant="ghost" icon={<ArrowLeft className="size-5" />} onClick={() => nav(`/pos/orders/${o.id}`)}>
          กลับไปที่บิล
        </Button>
        <h1 className="text-xl font-semibold">
          ชำระเงิน บิล <span className="num">#{o.orderNo}</span> {o.tableName && `· โต๊ะ ${o.tableName}`}
        </h1>
        <StatusBadge status={o.status} />
      </header>
      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <div className="flex flex-col gap-4">
          {payable && noShift && (
            <p className="rounded-control bg-turmeric-50 px-3 py-2 text-[#7A5806]">
              ยังไม่ได้เปิดกะ — <Link to="/shift" className="underline">เปิดกะก่อนรับเงิน</Link>
            </p>
          )}
          {payable ? (
            <Panel title="รับชำระ">
              <div className="mb-4 flex items-baseline justify-between">
                <span className="text-ink-2">ยอดค้างชำระ</span>
                <span className="num text-3xl font-semibold">{formatBaht(due)}</span>
              </div>
              <div className="mb-4 flex flex-wrap gap-2" role="radiogroup" aria-label="วิธีชำระ">
                {methods.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={method === m}
                    onClick={() => setMethod(m)}
                    className={clsx('min-h-12 rounded-control border px-4 font-medium', method === m ? 'border-basil bg-basil text-white' : 'border-line-strong bg-surface hover:bg-sunken')}
                  >
                    {METHOD_LABEL[m] ?? m}
                  </button>
                ))}
              </div>
              <div className="mb-3 flex items-center gap-2 text-sm">
                <span className="text-ink-2">แบ่งจ่าย</span>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button key={n} type="button" onClick={() => (setSplit(n), setAmount(''))} className={clsx('size-9 rounded-control border', split === n ? 'border-basil bg-basil-50 font-semibold text-basil-600' : 'border-line')}>
                    {n}
                  </button>
                ))}
                <span className="text-ink-3">คน {split > 1 && `· คนละ ${formatBaht(share)}`}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <MoneyInput label="ยอดที่ชำระครั้งนี้" value={amount} placeholder={(share / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} />
                {method === 'CASH' ? (
                  <MoneyInput label="รับเงินมา" value={tendered} placeholder={((amt ?? 0) / 100).toFixed(2)} onChange={(e) => setTendered(e.target.value)} />
                ) : (
                  <Input label={method === 'CARD' ? 'Approval code (EDC)' : 'เลขอ้างอิง'} value={reference} onChange={(e) => setReference(e.target.value)} hint={method === 'PROMPTPAY' ? 'ยืนยันหลังตรวจยอดเข้าบัญชี' : undefined} />
                )}
              </div>
              {method === 'CASH' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {[amt ?? 0, 10000, 50000, 100000].map((v, i) => (
                    <Button key={i} variant="outline" onClick={() => setTendered((v / 100).toFixed(2))}>
                      {i === 0 ? 'พอดี' : formatBaht(v)}
                    </Button>
                  ))}
                </div>
              )}
              {method === 'CASH' && tend != null && (
                <p className={clsx('mt-3 text-xl font-semibold', change < 0 ? 'text-chili' : 'text-basil-600')} aria-live="polite">
                  {change < 0 ? `ขาดอีก ${formatBaht(-change)}` : `เงินทอน ${formatBaht(change)}`}
                </p>
              )}
              {method === 'PROMPTPAY' && (
                <Button
                  variant="outline"
                  className="mt-3"
                  icon={<QrCode className="size-4" />}
                  disabled={!amt}
                  onClick={async () => {
                    try {
                      setQr({ ...(await get<{ dataUrl: string }>(`/orders/${o.id}/promptpay?amount=${amt}`)), amount: amt! });
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  แสดง QR PromptPay
                </Button>
              )}
              <Button size="lg" className="mt-4 w-full" loading={pay.isPending} disabled={noShift || due <= 0} onClick={submit}>
                {method === 'PROMPTPAY' || method === 'TRANSFER' ? 'บันทึก (รอยืนยันยอดเข้า)' : `รับชำระ ${formatBaht(amt ?? 0)}`}
              </Button>
              {o.grandTotalSatang === 0 && o.items.some((i) => i.status !== 'CANCELLED') && (
                <Button variant="outline" className="mt-2 w-full" onClick={() => act.mutate(() => post<Order>(`/orders/${o.id}/settle-zero`))}>
                  ปิดบิลยอด 0 บาท
                </Button>
              )}
            </Panel>
          ) : (
            o.status !== 'VOIDED' && (
              <Panel>
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <CheckCircle2 className="size-12 text-basil" />
                  <p className="text-xl font-semibold">ชำระเงินครบแล้ว</p>
                  <p className="text-ink-2">ใบเสร็จเลขที่ {o.receiptNo ?? '—'}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button icon={<Printer className="size-4" />} onClick={() => nav(`/pos/orders/${o.id}/receipt`)}>
                      พิมพ์ใบเสร็จ
                    </Button>
                    <Button variant="outline" onClick={() => setTaxOpen(true)}>
                      ขอใบกำกับภาษีเต็มรูป
                    </Button>
                    <Button variant="ghost" onClick={() => nav(o.tableId ? '/tables' : '/pos')}>
                      เสร็จสิ้น
                    </Button>
                  </div>
                </div>
              </Panel>
            )
          )}
          <Panel title="รายการชำระ">
            {payments.length === 0 ? (
              <p className="text-ink-3">ยังไม่มีการชำระ</p>
            ) : (
              <ul className="divide-y divide-line">
                {payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="font-medium">{METHOD_LABEL[p.method] ?? p.method}</span>
                    <StatusBadge status={p.status} />
                    <span className="text-xs text-ink-3">{fmtTime(p.createdAt)}</span>
                    {p.reference && <span className="text-xs text-ink-3">อ้างอิง {p.reference}</span>}
                    {p.changeSatang > 0 && <span className="text-xs text-ink-3">ทอน {formatBaht(p.changeSatang)}</span>}
                    {p.refundedSatang > 0 && <Badge tone="danger">คืนแล้ว {formatBaht(p.refundedSatang)}</Badge>}
                    <span className="num ml-auto font-semibold">{formatBaht(p.amountSatang)}</span>
                    {p.status === 'PENDING_CONFIRMATION' && (
                      <div className="flex w-full flex-wrap items-end gap-2">
                        {can('payment.confirm_transfer') && (
                          <>
                            <Input aria-label="เลขอ้างอิงการโอน" placeholder="เลขอ้างอิงจากธนาคาร" value={confirmRef[p.id] ?? ''} onChange={(e) => setConfirmRef({ ...confirmRef, [p.id]: e.target.value })} wrapClassName="flex-1" />
                            <Button size="sm" disabled={!confirmRef[p.id]} onClick={() => act.mutate(() => post<Order>(`/payments/${p.id}/confirm`, { reference: confirmRef[p.id] }))}>
                              ยืนยันยอดเข้าแล้ว
                            </Button>
                          </>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => act.mutate(() => post<Order>(`/payments/${p.id}/cancel`))}>
                          ยกเลิก
                        </Button>
                      </div>
                    )}
                    {p.status === 'CONFIRMED' && p.refundedSatang < p.amountSatang && (
                      <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setRefund(p)}>
                        คืนเงิน
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <Panel
          title="สรุปบิล"
          actions={
            payable &&
            o.paidSatang === 0 && (
              <Button size="sm" variant="outline" icon={<Percent className="size-4" />} onClick={() => setDiscountOpen(true)}>
                ส่วนลด
              </Button>
            )
          }
        >
          <ul className="mb-3 flex flex-col gap-1 text-sm">
            {o.items
              .filter((i) => i.status !== 'CANCELLED')
              .map((i) => (
                <li key={i.id} className="flex justify-between gap-2">
                  <span>
                    {i.qty}× {i.nameSnapshot}
                  </span>
                  <span className="num">{formatBaht(i.unitPriceSatang * i.qty)}</span>
                </li>
              ))}
          </ul>
          {o.discounts.length > 0 && (
            <ul className="mb-3 flex flex-col gap-1 border-t border-line pt-2 text-sm">
              {o.discounts.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 text-chili">
                  <span>
                    ส่วนลด{d.scope === 'ITEM' ? 'รายการ' : 'บิล'} {d.type === 'PERCENT' ? `${d.value / 100}%` : ''} — {d.reason}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="num">-{formatBaht(d.amountSatang)}</span>
                    {payable && o.paidSatang === 0 && can('bill.discount') && (
                      <button type="button" aria-label="ลบส่วนลด" className="rounded p-1 hover:bg-chili-50" onClick={() => act.mutate(() => del<Order>(`/discounts/${d.id}`))}>
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <TotalsBlock order={o} />
        </Panel>
      </div>
      {qr && (
        <Dialog open onClose={() => setQr(null)} title="สแกนจ่ายด้วย PromptPay" size="sm">
          <div className="flex flex-col items-center gap-2">
            <img src={qr.dataUrl} alt="PromptPay QR" className="size-64" />
            <p className="num text-2xl font-semibold">{formatBaht(qr.amount)}</p>
            <p className="text-center text-sm text-ink-2">ระบบจะไม่ยืนยันอัตโนมัติ ให้ตรวจยอดเข้าบัญชีแล้วกด "ยืนยันยอดเข้าแล้ว"</p>
          </div>
        </Dialog>
      )}
      {discountOpen && <DiscountDialog order={o} onClose={() => setDiscountOpen(false)} />}
      {refund && <RefundDialog order={o} payment={refund} onClose={() => setRefund(null)} />}
      {taxOpen && <TaxInvoiceDialog order={o} onClose={() => setTaxOpen(false)} />}
    </div>
  );
}
