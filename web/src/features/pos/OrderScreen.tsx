import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, ImageOff, MoreHorizontal, ReceiptText, Search, Send, UtensilsCrossed, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { MENU_TAGS } from '@shared/menu';
import { useApproval } from '../../components/ApprovalDialog';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Input, LoadingBlock, Select, Textarea, useToast } from '../../components/ui';
import { errorMessage, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtElapsed, formatBaht } from '../../lib/format';
import { LiveIndicator, useLivePolling } from '../../lib/realtime';
import { CHANNEL_LABEL } from '../menu/ItemDialog';
import type { BranchMenu, MenuItem } from '../menu/types';
import { ModifierDialog } from './ModifierDialog';
import { DraftTicketLine, groupByCourse, TicketLine, TotalsBlock } from './Ticket';
import type { DraftLine, Order, OrderItem } from './types';

export function useOrder(id: string | undefined) {
  const poll = useLivePolling();
  return useQuery({ queryKey: ['order', id], queryFn: () => get<Order>(`/orders/${id}`), enabled: !!id, refetchInterval: poll });
}
export function useBranchMenu(channel: string | undefined) {
  return useQuery({ queryKey: ['menu', channel], queryFn: () => get<BranchMenu>(`/menu?channel=${channel}`), enabled: !!channel, staleTime: 60_000 });
}

function ItemGrid({ menu, category, search, onPick }: { menu: BranchMenu; category: string; search: string; onPick: (i: MenuItem) => void }) {
  const q = search.trim().toLowerCase();
  const items = menu.items.filter((i) =>
    q ? i.name.toLowerCase().includes(q) || i.nameEn?.toLowerCase().includes(q) || i.sku?.toLowerCase() === q || i.barcode === q : category === 'all' || i.categoryId === category,
  );
  if (items.length === 0) return <EmptyState title={q ? `ไม่พบ "${search}"` : 'ไม่มีเมนูในหมวดนี้'} />;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
      {items.map((i) => (
        <li key={i.id}>
          <button
            type="button"
            disabled={!i.available}
            onClick={() => onPick(i)}
            className={clsx(
              'relative flex h-full min-h-24 w-full flex-col overflow-hidden rounded-panel border border-line bg-surface text-left transition-colors',
              i.available ? 'hover:border-basil active:bg-basil-50' : 'cursor-not-allowed opacity-55',
            )}
          >
            {i.imageUrl ? <img src={i.imageUrl} alt="" className="h-20 w-full object-cover" loading="lazy" /> : null}
            <span className="flex flex-1 flex-col gap-0.5 p-2.5">
              <span className="leading-snug font-medium">{i.name}</span>
              <span className="mt-auto flex items-center justify-between gap-1">
                <span className="num text-sm font-semibold text-basil-600">{formatBaht(i.priceSatang)}</span>
                {i.tags.includes('spicy') && <span className="text-xs text-chili">{MENU_TAGS.spicy}</span>}
              </span>
            </span>
            {!i.available && (
              <span className="absolute inset-x-0 top-2 mx-auto w-fit rounded bg-ink px-2 py-0.5 text-xs font-semibold text-white">
                {i.unavailableReason === 'SOLD_OUT' ? 'หมด' : i.unavailableReason === 'SCHEDULE' ? 'นอกเวลาขาย' : 'ปิดขาย'}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ServerLineDialog({ order, item, onClose }: { order: Order; item: OrderItem; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qty, setQty] = useState(item.qty);
  const [note, setNote] = useState(item.note ?? '');
  const [reason, setReason] = useState('');
  const cancelApproval = useApproval('order.cancel_item');
  const refresh = (o: Order) => qc.setQueryData(['order', order.id], o);
  const act = useMutation({
    mutationFn: (fn: () => Promise<Order>) => fn(),
    onSuccess: (o) => {
      refresh(o);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const pending = item.status === 'PENDING';
  return (
    <Dialog open onClose={onClose} title={item.nameSnapshot} size="sm">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Badge>{item.status}</Badge>
          <span className="num">{formatBaht(item.lineTotalSatang)}</span>
        </div>
        {pending ? (
          <>
            <Input label="จำนวน" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} />
            <Textarea label="หมายเหตุ" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button loading={act.isPending} onClick={() => act.mutate(() => patch<Order>(`/order-items/${item.id}`, { qty, note: note || null }))}>
                บันทึก
              </Button>
              {item.held && (
                <Button variant="outline" onClick={() => act.mutate(async () => (await post<{ order: Order }>(`/orders/${order.id}/send`, { itemIds: [item.id] })).order)}>
                  ส่งรายการนี้ (Fire)
                </Button>
              )}
              <Button variant="ghost" className="ml-auto text-chili" onClick={() => act.mutate(() => post<Order>(`/order-items/${item.id}/cancel`, {}))}>
                ลบรายการ
              </Button>
            </div>
          </>
        ) : item.status === 'CANCELLED' ? (
          <p className="text-ink-2">รายการนี้ถูกยกเลิกแล้ว: {item.cancelledReason}</p>
        ) : (
          <>
            {item.status === 'READY' && (
              <Button size="lg" onClick={() => act.mutate(() => post<Order>(`/order-items/${item.id}/served`))}>
                เสิร์ฟแล้ว
              </Button>
            )}
            {item.status !== 'SERVED' && (
              <>
                <Textarea label="เหตุผลการยกเลิก" required value={reason} onChange={(e) => setReason(e.target.value)} hint="รายการส่งครัวแล้ว ต้องมีเหตุผลและสิทธิ์ผู้จัดการ" />
                <Button
                  variant="danger"
                  disabled={reason.trim().length < 3}
                  loading={act.isPending}
                  onClick={() => cancelApproval.request((approval) => act.mutate(() => post<Order>(`/order-items/${item.id}/cancel`, { reason, approval })))}
                >
                  ยกเลิกรายการ
                </Button>
              </>
            )}
            {item.status === 'SERVED' && <p className="text-sm text-ink-2">เสิร์ฟแล้ว ยกเลิกไม่ได้ ใช้ส่วนลดหรือคืนเงินแทน</p>}
          </>
        )}
      </div>
      {cancelApproval.dialog}
    </Dialog>
  );
}

function QrSection({ order }: { order: Order }) {
  const toast = useToast();
  const [qr, setQr] = useState<{ url: string; qrDataUrl: string; expiresAt: string } | null>(null);
  const issue = useMutation({
    mutationFn: () => post<{ url: string; qrDataUrl: string; expiresAt: string }>(`/orders/${order.id}/qr`),
    onSuccess: setQr,
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <section>
      <h3 className="mb-2 font-semibold">QR ให้ลูกค้าสั่งเอง</h3>
      {qr ? (
        <div className="flex flex-col items-center gap-2 text-center">
          <img src={qr.qrDataUrl} alt="QR สั่งอาหาร" className="size-56" />
          <p className="text-sm">
            {order.tableName ? `โต๊ะ ${order.tableName}` : `บิล #${order.orderNo}`} · หมดอายุ {new Date(qr.expiresAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              พิมพ์ QR
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.open(qr.url, '_blank', 'noopener')}>
              เปิดหน้าลูกค้า (Kiosk)
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" loading={issue.isPending} onClick={() => issue.mutate()}>
          ออก QR ใหม่ (QR เดิมของบิลนี้จะใช้ไม่ได้)
        </Button>
      )}
    </section>
  );
}

function MoreDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [guests, setGuests] = useState(order.guestCount);
  const [voidOpen, setVoidOpen] = useState(false);
  const [mergeFrom, setMergeFrom] = useState('');
  const [splitQty, setSplitQty] = useState<Record<string, number>>({});
  const voidApproval = useApproval('order.void');
  const active = useQuery({ queryKey: ['orders', 'active'], queryFn: () => get<{ orders: { id: string; orderNo: string; tableName: string | null; status: string }[] }>('/orders?scope=active') });
  const act = useMutation({
    mutationFn: (fn: () => Promise<Order>) => fn(),
    onSuccess: (o) => {
      qc.setQueryData(['order', o.id], o);
      qc.invalidateQueries({ queryKey: ['order', order.id] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const live = order.items.filter((i) => i.status !== 'CANCELLED');
  const editable = ['OPEN', 'BILL_REQUESTED'].includes(order.status);
  return (
    <Dialog open onClose={onClose} title={`บิล #${order.orderNo}`} size="lg">
      <div className="flex flex-col gap-5">
        {editable && (
          <section className="flex items-end gap-2">
            <Input label="จำนวนลูกค้า" type="number" min={1} max={100} value={guests} onChange={(e) => setGuests(Number(e.target.value))} wrapClassName="w-32" />
            <Button variant="outline" onClick={() => act.mutate(() => patch<Order>(`/orders/${order.id}`, { guestCount: guests }))}>
              บันทึก
            </Button>
          </section>
        )}
        {editable && can('bill.split') && (
          <section>
            <h3 className="mb-2 font-semibold">แยกบิลตามรายการ</h3>
            <ul className="mb-2 flex flex-col gap-1">
              {live.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="number"
                    min={0}
                    max={i.qty}
                    aria-label={`จำนวน ${i.nameSnapshot} ที่แยก`}
                    className="h-9 w-16 rounded-control border border-line-strong px-2 text-right"
                    value={splitQty[i.id] ?? 0}
                    onChange={(e) => setSplitQty({ ...splitQty, [i.id]: Math.max(0, Math.min(i.qty, Number(e.target.value) || 0)) })}
                  />
                  <span>
                    / {i.qty} × {i.nameSnapshot}
                  </span>
                </li>
              ))}
            </ul>
            <Button
              variant="outline"
              disabled={!Object.values(splitQty).some((v) => v > 0)}
              loading={act.isPending}
              onClick={() =>
                act.mutate(async () => {
                  const o = await post<Order>(`/orders/${order.id}/split`, { lines: Object.entries(splitQty).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty })) });
                  toast.success(`แยกเป็นบิล #${o.orderNo} แล้ว`);
                  onClose();
                  nav(`/pos/orders/${o.id}`);
                  return o;
                })
              }
            >
              แยกเป็นบิลใหม่
            </Button>
          </section>
        )}
        {editable && can('bill.split') && (
          <section className="flex items-end gap-2">
            <Select label="รวมบิลอื่นเข้ามาในบิลนี้" value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} wrapClassName="flex-1">
              <option value="">เลือกบิล</option>
              {active.data?.orders
                .filter((o) => o.id !== order.id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    #{o.orderNo} {o.tableName ? `โต๊ะ ${o.tableName}` : ''}
                  </option>
                ))}
            </Select>
            <Button variant="outline" disabled={!mergeFrom} onClick={() => act.mutate(() => post<Order>(`/orders/${order.id}/merge`, { fromOrderId: mergeFrom }))}>
              รวมบิล
            </Button>
          </section>
        )}
        {editable && <QrSection order={order} />}
        {editable && order.paidSatang === 0 && (
          <section>
            <Button variant="danger" onClick={() => setVoidOpen(true)}>
              Void บิลนี้
            </Button>
          </section>
        )}
      </div>
      <ConfirmDialog
        open={voidOpen}
        title={`Void บิล #${order.orderNo}?`}
        message="รายการทั้งหมดจะถูกยกเลิก และบันทึกใน Audit Log"
        confirmLabel="Void บิล"
        danger
        requireReason
        loading={act.isPending}
        onClose={() => setVoidOpen(false)}
        onConfirm={(reason) =>
          voidApproval.request((approval) =>
            act.mutate(async () => {
              const o = await post<Order>(`/orders/${order.id}/void`, { reason, approval });
              setVoidOpen(false);
              onClose();
              toast.success('Void บิลแล้ว');
              return o;
            }),
          )
        }
      />
      {voidApproval.dialog}
    </Dialog>
  );
}

function QrApprovalBar({ order }: { order: Order }) {
  const qc = useQueryClient();
  const toast = useToast();
  const act = useMutation({
    mutationFn: (reject: boolean) => post<{ order: Order }>(`/orders/${order.id}/approve-qr`, { reject }),
    onSuccess: (r, reject) => {
      qc.setQueryData(['order', order.id], r.order);
      qc.invalidateQueries({ queryKey: ['qr-pending'] });
      toast.success(reject ? 'ปฏิเสธรายการจาก QR แล้ว' : 'อนุมัติและส่งครัวแล้ว');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const n = order.items.filter((i) => i.awaitingApproval && i.status === 'PENDING').length;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-control bg-sky-50 px-3 py-2 text-sm">
      <span>ลูกค้าสั่งผ่าน QR {n} รายการ รออนุมัติ (ดูในบิลด้านขวา)</span>
      <Button size="sm" className="ml-auto" loading={act.isPending && act.variables === false} onClick={() => act.mutate(false)}>
        อนุมัติส่งครัว
      </Button>
      <Button size="sm" variant="ghost" className="text-chili" onClick={() => act.mutate(true)}>
        ปฏิเสธ
      </Button>
    </div>
  );
}

export function OrderScreen() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, me } = useAuth();
  const order = useOrder(id);
  const menu = useBranchMenu(order.data?.channel);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<DraftLine[]>([]);
  const [editing, setEditing] = useState<{ item: MenuItem; draft?: DraftLine } | null>(null);
  const [serverLine, setServerLine] = useState<OrderItem | null>(null);
  const [more, setMore] = useState(false);
  const [showTicket, setShowTicket] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Warn before leaving with unsaved lines.
  useEffect(() => {
    if (drafts.length === 0) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [drafts.length]);

  const save = useMutation({
    mutationFn: async (send: boolean) => {
      if (drafts.length) {
        return post<Order>(`/orders/${id}/items`, {
          send,
          items: drafts.map((d) => ({ id: d.id, menuItemId: d.menuItemId, qty: d.qty, modifiers: d.modifiers.map((m) => ({ modifierId: m.modifierId, qty: m.qty })), note: d.note, course: d.course, held: d.held })),
        });
      }
      return (await post<{ order: Order }>(`/orders/${id}/send`, {})).order;
    },
    onSuccess: (o, send) => {
      qc.setQueryData(['order', id], o);
      setDrafts([]);
      qc.invalidateQueries({ queryKey: ['tables'] });
      toast.success(send ? 'ส่งเข้าครัวแล้ว' : 'บันทึกรายการแล้ว');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const billAction = useMutation({
    mutationFn: (path: string) => post<Order>(`/orders/${id}/${path}`),
    onSuccess: (o) => {
      qc.setQueryData(['order', id], o);
      qc.invalidateQueries({ queryKey: ['tables'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const draftTotal = drafts.reduce((a, d) => a + d.unitPriceSatang * d.qty, 0);
  const groups = useMemo(() => groupByCourse(order.data?.items ?? []), [order.data]);

  if (order.isLoading) return <div className="p-6"><LoadingBlock /></div>;
  if (order.error || !order.data) return <div className="p-6"><ErrorState error={order.error} onRetry={() => order.refetch()} /></div>;
  const o = order.data;
  const editable = o.status === 'OPEN';
  const pendingServer = o.items.filter((i) => i.status === 'PENDING' && !i.held).length;
  const pick = (i: MenuItem) => {
    if (!editable) return toast.error('บิลนี้แก้ไขไม่ได้ในสถานะปัจจุบัน');
    if (i.modifierGroups.length > 0) setEditing({ item: i });
    else
      setDrafts((d) => {
        const same = d.find((x) => x.menuItemId === i.id && x.modifiers.length === 0 && !x.note);
        if (same) return d.map((x) => (x === same ? { ...x, qty: Math.min(99, x.qty + 1) } : x));
        return [...d, { id: crypto.randomUUID(), menuItemId: i.id, name: i.name, unitPriceSatang: i.priceSatang, qty: 1, modifiers: [], course: i.defaultCourse }];
      });
  };

  const ticket = (
    <div className="ticket flex h-full min-h-0 flex-col border-l border-line">
      <div className="border-b border-dashed border-line-strong px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            บิล <span className="num">#{o.orderNo}</span>
          </h2>
          <Badge tone={o.status === 'OPEN' ? 'info' : o.status === 'BILL_REQUESTED' ? 'warning' : o.status === 'VOIDED' ? 'danger' : 'success'}>{o.status}</Badge>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-ink-2">
          <span>{o.tableName ? `โต๊ะ ${o.tableName}` : CHANNEL_LABEL[o.channel] ?? o.channel}</span>
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5" />
            {o.guestCount}
          </span>
          <span>{fmtElapsed(o.openedAt)}</span>
          {o.customerName && <span>{o.customerName}</span>}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {o.items.length === 0 && drafts.length === 0 && <EmptyState icon={<UtensilsCrossed className="size-7" />} title="ยังไม่มีรายการ">แตะเมนูทางซ้ายเพื่อเพิ่ม</EmptyState>}
        {groups.map((g) => (
          <section key={g.course}>
            {groups.length > 1 && <h3 className="px-4 pt-2 text-xs font-medium text-ink-3">รอบ {g.course} · {g.label}</h3>}
            <ul>
              {g.items.map((it) => (
                <TicketLine key={it.id} item={it} onClick={() => setServerLine(it)} />
              ))}
            </ul>
          </section>
        ))}
        {drafts.length > 0 && (
          <ul className="mt-1">
            {drafts.map((d) => (
              <DraftTicketLine key={d.id} line={d} onClick={() => setEditing({ item: menu.data!.items.find((m) => m.id === d.menuItemId)!, draft: d })} />
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-dashed border-line-strong px-4 py-3">
        <TotalsBlock order={o} draftTotal={draftTotal} />
        <div className="mt-3 grid grid-cols-2 gap-2">
          {editable && (drafts.length > 0 || pendingServer > 0) ? (
            <>
              <Button variant="outline" size="lg" disabled={drafts.length === 0} loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>
                บันทึก
              </Button>
              {can('order.send') && (
                <Button size="lg" icon={<Send className="size-4" />} loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>
                  ส่งครัว
                </Button>
              )}
            </>
          ) : (
            <>
              {o.status === 'OPEN' && can('order.request_bill') && (
                <Button variant="outline" size="lg" disabled={o.items.length === 0} loading={billAction.isPending} onClick={() => billAction.mutate('request-bill')}>
                  เรียกเช็กบิล
                </Button>
              )}
              {o.status === 'BILL_REQUESTED' && (
                <Button variant="outline" size="lg" loading={billAction.isPending} onClick={() => billAction.mutate('reopen')}>
                  แก้ไขบิล
                </Button>
              )}
              {['OPEN', 'BILL_REQUESTED'].includes(o.status) && can('payment.take') && (
                <Button size="lg" icon={<ReceiptText className="size-4" />} disabled={o.items.filter((i) => i.status !== 'CANCELLED').length === 0} onClick={() => nav(`/pos/orders/${o.id}/pay`)}>
                  ชำระเงิน
                </Button>
              )}
              {['PAID', 'CLOSED'].includes(o.status) && (
                <Button size="lg" variant="outline" className="col-span-2" onClick={() => nav(`/pos/orders/${o.id}/pay`)}>
                  ใบเสร็จ / การชำระ
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="no-print flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-5" />} onClick={() => (drafts.length && !confirm('มีรายการยังไม่บันทึก ออกจากหน้านี้?') ? null : nav(o.tableId ? '/tables' : '/pos'))}>
          <span className="hidden sm:inline">{o.tableId ? 'ผังโต๊ะ' : 'บิลทั้งหมด'}</span>
        </Button>
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Barcode scanners type the code then Enter: add the exact SKU/barcode match directly.
              if (e.key !== 'Enter' || !menu.data) return;
              const q = search.trim().toLowerCase();
              const hit = menu.data.items.find((i) => i.barcode === q || i.sku?.toLowerCase() === q);
              if (hit) {
                pick(hit);
                setSearch('');
              }
            }}
            placeholder="ค้นหาเมนู / สแกนบาร์โค้ด"
            aria-label="ค้นหาเมนูหรือสแกนบาร์โค้ด"
            className="h-10 w-full rounded-control border border-line-strong bg-surface pr-3 pl-9"
          />
        </div>
        <LiveIndicator />
        <span className="hidden text-sm text-ink-2 md:inline">{me?.user.name}</span>
        {o.items.some((i) => ['SENT', 'PREPARING'].includes(i.status)) && (
          <Link to={`/kitchen-ticket/${o.id}`} className="hidden sm:block">
            <Button variant="ghost" size="sm">
              พิมพ์ใบครัว
            </Button>
          </Link>
        )}
        <Link to={`/pos/orders/${o.id}/receipt`} className="hidden sm:block">
          <Button variant="ghost" size="sm">
            พิมพ์ใบแจ้งยอด
          </Button>
        </Link>
        <Button variant="ghost" size="sm" aria-label="ตัวเลือกบิล" icon={<MoreHorizontal className="size-5" />} onClick={() => setMore(true)} />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="หมวดหมู่" className="hidden w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-2 md:flex">
          {[{ id: 'all', name: 'ทั้งหมด' }, ...(menu.data?.categories ?? [])].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => (setCategory(c.id), setSearch(''))}
              className={clsx('min-h-11 rounded-control px-3 text-left', category === c.id && !search ? 'bg-basil text-white' : 'hover:bg-sunken')}
            >
              {c.name}
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-3">
          <div className="mb-3 flex gap-1 overflow-x-auto md:hidden">
            {[{ id: 'all', name: 'ทั้งหมด' }, ...(menu.data?.categories ?? [])].map((c) => (
              <Button key={c.id} size="sm" variant={category === c.id ? 'primary' : 'outline'} onClick={() => setCategory(c.id)}>
                {c.name}
              </Button>
            ))}
          </div>
          {o.items.some((i) => i.awaitingApproval && i.status === 'PENDING') && can('order.approve_qr') && <QrApprovalBar order={o} />}
          {!editable && (
            <p className="mb-3 rounded-control bg-turmeric-50 px-3 py-2 text-sm text-[#7A5806]">
              {o.status === 'BILL_REQUESTED' ? 'เรียกเช็กบิลแล้ว — กด "แก้ไขบิล" เพื่อสั่งเพิ่ม' : `บิลนี้สถานะ ${o.status} แก้ไขรายการไม่ได้`}
            </p>
          )}
          {menu.isLoading ? <LoadingBlock /> : menu.error ? <ErrorState error={menu.error} onRetry={() => menu.refetch()} /> : menu.data && <ItemGrid menu={menu.data} category={category} search={search} onPick={pick} />}
          {menu.data && menu.data.items.length === 0 && (
            <EmptyState icon={<ImageOff className="size-7" />} title="ยังไม่มีเมนู">
              {can('menu.manage') ? <Link to="/menu" className="text-sky underline">ไปเพิ่มเมนู</Link> : 'ติดต่อผู้จัดการ'}
            </EmptyState>
          )}
        </main>
        <aside className="hidden w-[380px] shrink-0 lg:block">{ticket}</aside>
      </div>
      <div className="no-print border-t border-line bg-surface p-2 lg:hidden">
        <Button size="lg" className="w-full" onClick={() => setShowTicket(true)}>
          ดูบิล ({o.items.filter((i) => i.status !== 'CANCELLED').length + drafts.length}) · <span className="num">{formatBaht(o.grandTotalSatang + draftTotal)}</span>
        </Button>
      </div>
      {showTicket && (
        <div className="fixed inset-0 z-40 flex flex-col bg-surface lg:hidden" role="dialog" aria-modal="true" aria-label="บิล">
          <div className="flex justify-end border-b border-line p-2">
            <Button variant="ghost" onClick={() => setShowTicket(false)}>
              ปิด
            </Button>
          </div>
          <div className="min-h-0 flex-1">{ticket}</div>
        </div>
      )}
      {editing && (
        <ModifierDialog
          item={editing.item}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onRemove={editing.draft ? () => (setDrafts((d) => d.filter((x) => x.id !== editing.draft!.id)), setEditing(null)) : undefined}
          onConfirm={(line) => {
            setDrafts((d) => (editing.draft ? d.map((x) => (x.id === editing.draft!.id ? { ...line, id: x.id } : x)) : [...d, { ...line, id: crypto.randomUUID() }]));
            setEditing(null);
          }}
        />
      )}
      {serverLine && <ServerLineDialog order={o} item={serverLine} onClose={() => setServerLine(null)} />}
      {more && <MoreDialog order={o} onClose={() => setMore(false)} />}
      {drafts.length > 0 && (
        <div className="no-print fixed bottom-20 left-3 z-30 lg:bottom-3">
          <Button variant="ghost" size="sm" className="bg-surface shadow" onClick={() => setDrafts([])}>
            ล้างรายการที่ยังไม่บันทึก ({drafts.length})
          </Button>
        </div>
      )}
    </div>
  );
}
