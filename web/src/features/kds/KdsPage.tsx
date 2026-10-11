import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowLeft, Ban, History, Lock, Printer, Sigma, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ALLERGENS } from '@shared/menu';
import { Dialog, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { LiveIndicator, useLivePolling, useRealtimeEvent } from '../../lib/realtime';
import { CHANNEL_LABEL } from '../menu/ItemDialog';
import type { BranchMenu } from '../menu/types';
import type { OrderItem } from '../pos/types';

interface Ticket {
  orderId: string;
  orderNo: string;
  channel: string;
  tableName: string | null;
  guestCount: number;
  customerName: string | null;
  orderNote: string | null;
  firstSentAt: string;
  items: OrderItem[];
}
interface KdsData {
  station: string;
  lockedStation: string | null;
  thresholds: { warnMinutes: number; lateMinutes: number };
  serverTime: string;
  tickets: Ticket[];
}

const NEXT: Record<string, 'PREPARING' | 'READY' | 'SERVED' | null> = { SENT: 'PREPARING', PREPARING: 'READY', READY: 'SERVED' };
const PREV: Record<string, 'SENT' | 'PREPARING' | null> = { PREPARING: 'SENT', READY: 'PREPARING' };
const STORAGE_KEY = 'rms.kds.station';

function useClock(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Short beep for new tickets (WebAudio; browsers allow it after the first tap on the page). */
function beep() {
  try {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch {
    /* audio unavailable */
  }
}

function SoldOutDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const menu = useQuery({ queryKey: ['menu', 'DINE_IN'], queryFn: () => get<BranchMenu>('/menu?channel=DINE_IN') });
  const toggle = useMutation({
    mutationFn: (v: { id: string; soldOut: boolean }) => post(`/menu/items/${v.id}/sold-out`, { soldOut: v.soldOut }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['menu'] });
      toast.success(v.soldOut ? 'แจ้งหมดแล้ว — ปิดขายใน POS/QR ทันที' : 'เปิดขายอีกครั้ง');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items = (menu.data?.items ?? []).filter((i) => !q || i.name.includes(q));
  return (
    <Dialog open onClose={onClose} title="แจ้งเมนูหมด" size="lg">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาเมนู" aria-label="ค้นหาเมนู" className="mb-3 h-11 w-full rounded-control border border-line-strong px-3" />
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => toggle.mutate({ id: i.id, soldOut: !i.soldOut })}
              className={clsx('flex min-h-12 w-full items-center justify-between rounded-control border px-3 text-left', i.soldOut ? 'border-chili bg-chili-50 text-chili' : 'border-line hover:bg-sunken')}
            >
              <span>{i.name}</span>
              <span className="text-sm font-semibold">{i.soldOut ? 'หมด — แตะเพื่อเปิดขาย' : 'แตะเพื่อแจ้งหมด'}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function TicketCard({ t, now, thresholds, onBump, busy, expo }: { t: Ticket; now: number; thresholds: KdsData['thresholds']; onBump: (ids: string[], status: string) => void; busy: boolean; expo: boolean }) {
  const ageMin = (now - new Date(t.firstSentAt).getTime()) / 60000;
  const tone = ageMin >= thresholds.lateMinutes ? 'late' : ageMin >= thresholds.warnMinutes ? 'warn' : 'ok';
  const open = t.items.filter((i) => i.status !== 'READY');
  const ready = t.items.filter((i) => i.status === 'READY');
  return (
    <article
      className={clsx('flex break-inside-avoid flex-col overflow-hidden rounded-panel border-2 bg-[#1F1F1F] text-[#F2F2F2]', tone === 'late' ? 'border-chili' : tone === 'warn' ? 'border-turmeric' : 'border-[#333333]')}
      aria-label={`บิล ${t.orderNo}`}
    >
      <header className={clsx('flex items-center justify-between gap-2 px-3 py-2', tone === 'late' ? 'bg-chili text-white' : tone === 'warn' ? 'bg-turmeric text-black' : 'bg-[#2B2B2B]')}>
        <div className="min-w-0">
          <div className="text-xl leading-tight font-bold">{t.tableName ? `โต๊ะ ${t.tableName}` : (CHANNEL_LABEL[t.channel] ?? t.channel)}</div>
          <div className="text-sm opacity-90">
            #{t.orderNo} · {t.guestCount} คน {t.customerName && `· ${t.customerName}`}
          </div>
        </div>
        <div className="num text-2xl font-bold" aria-label="เวลารอ">
          {mmss(now - new Date(t.firstSentAt).getTime())}
        </div>
      </header>
      {t.orderNote && <p className="bg-[#3A3420] px-3 py-1 text-sm text-[#FFE08A]">{t.orderNote}</p>}
      <ul className="flex flex-col divide-y divide-[#333333]">
        {t.items.map((i) => {
          const next = expo ? (i.status === 'READY' ? 'SERVED' : NEXT[i.status]) : i.status === 'READY' ? null : NEXT[i.status];
          return (
            <li key={i.id} className={clsx('flex items-stretch', i.status === 'READY' && 'bg-basil/25', i.status === 'PREPARING' && 'bg-sky/15')}>
              <button
                type="button"
                disabled={!next || busy}
                onClick={() => next && onBump([i.id], next)}
                className="flex min-h-14 flex-1 gap-3 px-3 py-2 text-left disabled:cursor-default"
                aria-label={`${i.qty} ${i.nameSnapshot} สถานะ ${i.status}${next ? ` แตะเพื่อเปลี่ยนเป็น ${next}` : ''}`}
              >
                <span className="num w-9 shrink-0 text-2xl font-bold">{i.qty}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-lg leading-snug font-semibold">{i.nameSnapshot}</span>
                  {i.course > 1 && <span className="ml-2 rounded bg-[#333333] px-1.5 text-xs">รอบ {i.course}</span>}
                  {i.modifiers.map((m, k) => (
                    <span key={k} className="block text-base text-[#C2C2C2]">
                      + {m.name}
                      {m.qty > 1 && ` ×${m.qty}`}
                    </span>
                  ))}
                  {i.comboComponents.length > 0 && <span className="block text-sm text-[#C2C2C2]">ชุด: {i.comboComponents.map((c) => `${c.name}${c.qty > 1 ? ` ×${c.qty}` : ''}`).join(', ')}</span>}
                  {i.note && <span className="mt-0.5 block rounded bg-[#FFE08A] px-1.5 text-base font-semibold text-black">⚑ {i.note}</span>}
                  {i.allergens.length > 0 && (
                    <span className="mt-0.5 flex items-center gap-1 text-sm font-bold text-[#FF8A80]">
                      <AlertTriangle className="size-4" /> แพ้: {i.allergens.map((a) => ALLERGENS[a] ?? a).join(', ')}
                    </span>
                  )}
                </span>
                <span className="shrink-0 self-center text-sm font-semibold uppercase">{i.status === 'SENT' ? 'ใหม่' : i.status === 'PREPARING' ? 'กำลังทำ' : 'เสร็จ'}</span>
              </button>
              {PREV[i.status] && (
                <button type="button" aria-label="ย้อนสถานะ" disabled={busy} onClick={() => onBump([i.id], PREV[i.status]!)} className="px-2 text-[#A3A3A3] hover:text-white">
                  <Undo2 className="size-5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <footer className="mt-auto flex gap-2 p-2">
        {open.length > 0 && (
          <button type="button" disabled={busy} onClick={() => onBump(open.map((i) => i.id), 'READY')} className="min-h-12 flex-1 rounded-control bg-basil text-lg font-semibold text-white hover:bg-basil-600">
            เสร็จทั้งบิล
          </button>
        )}
        {expo && ready.length > 0 && (
          <button type="button" disabled={busy} onClick={() => onBump(ready.map((i) => i.id), 'SERVED')} className="min-h-12 flex-1 rounded-control bg-sky text-lg font-semibold text-white">
            เสิร์ฟแล้ว ({ready.length})
          </button>
        )}
        <Link to={`/kitchen-ticket/${t.orderId}?itemIds=${t.items.map((i) => i.id).join(',')}`} className="flex min-h-12 items-center rounded-control bg-[#333333] px-3" aria-label="พิมพ์ใบสั่งครัว">
          <Printer className="size-5" />
        </Link>
      </footer>
    </article>
  );
}

export function KdsPage() {
  const nav = useNavigate();
  const { me, can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const poll = useLivePolling();
  const now = useClock();
  const [station, setStation] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? 'ALL';
    } catch {
      return 'ALL';
    }
  });
  const [allDay, setAllDay] = useState(false);
  const [soldOut, setSoldOut] = useState(false);
  const [recall, setRecall] = useState(false);
  const stations = useQuery({ queryKey: ['stations'], queryFn: () => get<{ stations: { id: string; code: string; name: string; isExpo: boolean }[] }>('/stations') });
  const kds = useQuery({ queryKey: ['kds', station], queryFn: () => get<KdsData>(`/kds?station=${station}`), refetchInterval: Math.min(poll, 15_000) });
  const counts = useQuery({ queryKey: ['kds', 'all-day', station], queryFn: () => get<{ counts: { name: string; qty: number; tickets: number }[] }>(`/kds/all-day?station=${station}`), enabled: allDay, refetchInterval: 20_000 });
  const recent = useQuery({ queryKey: ['kds', 'recent'], queryFn: () => get<{ items: (OrderItem & { orderNo: string; tableName: string | null })[] }>('/kds/recent'), enabled: recall });
  const expo = station === 'ALL' || !!stations.data?.stations.find((s) => s.code === station)?.isExpo;
  const seen = useRef(new Set<string>());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, station);
    } catch {
      /* storage unavailable */
    }
  }, [station]);

  useRealtimeEvent((e) => {
    if (e.type === 'kitchen.ticket') {
      const relevant = station === 'ALL' || expo || (e.payload.stations as string[]).includes(station);
      if (relevant && !seen.current.has(e.payload.orderId + e.payload.itemIds.join())) {
        seen.current.add(e.payload.orderId + e.payload.itemIds.join());
        beep();
      }
    }
  });

  const bump = useMutation({
    mutationFn: (v: { ids: string[]; status: string }) => post('/kds/status', { itemIds: v.ids, status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kds'] }),
    onError: (e) => {
      toast.error(errorMessage(e));
      qc.invalidateQueries({ queryKey: ['kds'] });
    },
  });

  const effectiveStation = kds.data?.lockedStation ?? station;
  const tickets = useMemo(() => kds.data?.tickets ?? [], [kds.data]);
  const offset = kds.data ? new Date(kds.data.serverTime).getTime() - (kds.dataUpdatedAt || Date.now()) : 0;

  return (
    <div className="kds flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#333333] px-3 py-2">
        <button type="button" onClick={() => nav('/')} className="flex size-11 items-center justify-center rounded hover:bg-[#2B2B2B]" aria-label="ออกจากจอครัว">
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="text-lg font-semibold">จอครัว</h1>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="สเตชัน">
          {kds.data?.lockedStation ? (
            <span className="flex items-center gap-1 rounded bg-[#2B2B2B] px-3 py-1.5">
              <Lock className="size-4" /> {kds.data.lockedStation}
            </span>
          ) : (
            [{ code: 'ALL', name: 'ทุกสเตชัน (จุดส่งอาหาร)' }, ...(stations.data?.stations ?? [])].map((s) => (
              <button
                key={s.code}
                type="button"
                role="tab"
                aria-selected={station === s.code}
                onClick={() => setStation(s.code)}
                className={clsx('min-h-10 rounded px-3', station === s.code ? 'bg-brand text-white' : 'bg-[#2B2B2B] hover:bg-[#3D3D3D]')}
              >
                {s.name}
              </button>
            ))
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <LiveIndicator />
          <span className="num hidden text-lg sm:inline">{new Date(now).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span>
          <button type="button" onClick={() => setAllDay(!allDay)} aria-pressed={allDay} className={clsx('flex min-h-10 items-center gap-1 rounded px-3', allDay ? 'bg-sky' : 'bg-[#2B2B2B]')}>
            <Sigma className="size-4" /> รวมยอด
          </button>
          <button type="button" onClick={() => setRecall(true)} className="flex min-h-10 items-center gap-1 rounded bg-[#2B2B2B] px-3">
            <History className="size-4" /> ย้อนดู
          </button>
          {can('menu.sold_out') && (
            <button type="button" onClick={() => setSoldOut(true)} className="flex min-h-10 items-center gap-1 rounded bg-chili px-3 text-white">
              <Ban className="size-4" /> แจ้งหมด
            </button>
          )}
          <span className="hidden text-sm opacity-70 md:inline">{me?.user.name}</span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto p-3">
          {kds.error ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-[#FF8A80]">{errorMessage(kds.error)}</p>
              <button type="button" onClick={() => kds.refetch()} className="min-h-11 rounded bg-[#2B2B2B] px-4">
                ลองใหม่
              </button>
            </div>
          ) : tickets.length === 0 ? (
            <p className="mt-20 text-center text-xl opacity-60">{kds.isLoading ? 'กำลังโหลด…' : `ไม่มีออเดอร์ค้างที่ ${effectiveStation === 'ALL' ? 'ทุกสเตชัน' : effectiveStation}`}</p>
          ) : (
            <div className="columns-1 gap-3 space-y-3 sm:columns-2 xl:columns-3 2xl:columns-4">
              {tickets.map((t) => (
                <TicketCard key={t.orderId} t={t} now={now + offset} thresholds={kds.data!.thresholds} expo={expo} busy={bump.isPending} onBump={(ids, status) => bump.mutate({ ids, status })} />
              ))}
            </div>
          )}
        </main>
        {allDay && (
          <aside className="fixed inset-x-0 bottom-0 z-20 max-h-[45dvh] overflow-y-auto border-t border-[#333333] bg-[#121212] p-3 sm:static sm:max-h-none sm:w-64 sm:shrink-0 sm:border-t-0 sm:border-l" aria-label="ยอดรวมที่ต้องทำ">
            <h2 className="mb-2 font-semibold">ต้องทำทั้งหมด</h2>
            <ul className="flex flex-col gap-1">
              {(counts.data?.counts ?? []).map((c) => (
                <li key={c.name} className="flex justify-between gap-2 rounded bg-[#1F1F1F] px-2 py-1.5 text-lg">
                  <span>{c.name}</span>
                  <span className="num font-bold">×{c.qty}</span>
                </li>
              ))}
              {counts.data?.counts.length === 0 && <li className="opacity-60">ไม่มี</li>}
            </ul>
          </aside>
        )}
      </div>
      {soldOut && <SoldOutDialog onClose={() => setSoldOut(false)} />}
      {recall && (
        <Dialog open onClose={() => setRecall(false)} title="รายการที่เสร็จใน 30 นาทีล่าสุด" size="lg">
          <ul className="divide-y divide-line">
            {(recent.data?.items ?? []).map((i) => (
              <li key={i.id} className="flex items-center gap-2 py-2">
                <span className="num font-semibold">{i.qty}×</span>
                <span className="flex-1">
                  {i.nameSnapshot} <span className="text-sm text-ink-3">#{i.orderNo} {i.tableName && `โต๊ะ ${i.tableName}`}</span>
                </span>
                <span className="text-sm">{i.status === 'SERVED' ? 'เสิร์ฟแล้ว' : 'เสร็จ'}</span>
                {i.status === 'READY' && (
                  <button type="button" className="min-h-11 rounded-control border border-line px-3 text-sm" onClick={() => bump.mutate({ ids: [i.id], status: 'PREPARING' })}>
                    เรียกกลับมาทำ
                  </button>
                )}
              </li>
            ))}
          </ul>
          {recent.data && recent.data.items.length === 0 && <p className="py-6 text-center text-ink-3">ยังไม่มีรายการที่เสร็จใน 30 นาทีล่าสุด</p>}
        </Dialog>
      )}
    </div>
  );
}
