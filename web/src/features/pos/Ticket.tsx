import { clsx } from 'clsx';
import { AlertTriangle, Clock, PauseCircle } from 'lucide-react';
import { ALLERGENS } from '@shared/menu';
import { StatusBadge } from '../../components/ui';
import { formatBaht } from '../../lib/format';
import type { DraftLine, Order, OrderItem } from './types';

const COURSE = ['', 'ของทานเล่น', 'จานหลัก', 'ของหวาน', 'รอบ 4', 'รอบ 5'];

function Mods({ mods }: { mods: { name: string; qty?: number; priceDeltaSatang: number }[] }) {
  if (mods.length === 0) return null;
  return (
    <ul className="text-sm text-ink-2">
      {mods.map((m, i) => (
        <li key={i}>
          + {m.name}
          {(m.qty ?? 1) > 1 && ` ×${m.qty}`}
          {m.priceDeltaSatang !== 0 && <span className="num"> ({formatBaht(m.priceDeltaSatang * (m.qty ?? 1))})</span>}
        </li>
      ))}
    </ul>
  );
}

export function TicketLine({ item, onClick }: { item: OrderItem; onClick?: () => void }) {
  const cancelled = item.status === 'CANCELLED';
  return (
    <li>
      <button type="button" onClick={onClick} disabled={!onClick} className={clsx('flex w-full gap-2 px-4 py-2 text-left hover:bg-sunken/60 disabled:hover:bg-transparent', cancelled && 'opacity-50')}>
        <span className="num w-7 shrink-0 font-semibold">{item.qty}×</span>
        <span className="min-w-0 flex-1">
          <span className={clsx('font-medium', cancelled && 'line-through')}>{item.nameSnapshot}</span>
          <Mods mods={item.modifiers} />
          {item.comboComponents.length > 0 && <span className="block text-xs text-ink-3">ชุด: {item.comboComponents.map((c) => c.name).join(', ')}</span>}
          {item.note && <span className="block text-sm text-turmeric-700">“{item.note}”</span>}
          {item.allergens.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-chili">
              <AlertTriangle className="size-3" /> {item.allergens.map((a) => ALLERGENS[a] ?? a).join(', ')}
            </span>
          )}
          {cancelled && item.cancelledReason && <span className="block text-xs text-chili">ยกเลิก: {item.cancelledReason}</span>}
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={item.status} />
            {item.held && item.status === 'PENDING' && (
              <span className="inline-flex items-center gap-0.5 text-xs text-ink-3">
                <PauseCircle className="size-3" /> พักไว้ ({COURSE[item.course]})
              </span>
            )}
          </span>
        </span>
        <span className="num shrink-0 text-right">
          {formatBaht(item.unitPriceSatang * item.qty)}
          {item.discountSatang > 0 && <span className="block text-xs text-chili">-{formatBaht(item.discountSatang)}</span>}
        </span>
      </button>
    </li>
  );
}

export function DraftTicketLine({ line, onClick }: { line: DraftLine; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full gap-2 border-l-4 border-sky bg-sky-50/60 px-3 py-2 text-left hover:bg-sky-50">
        <span className="num w-7 shrink-0 font-semibold">{line.qty}×</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium">{line.name}</span>
          <Mods mods={line.modifiers} />
          {line.note && <span className="block text-sm text-turmeric-700">“{line.note}”</span>}
          <span className="flex items-center gap-1 text-xs text-sky">
            <Clock className="size-3" />
            {line.queued ? 'บันทึกในเครื่อง รอซิงก์' : 'ยังไม่บันทึก'}
            {line.held ? ' · พักไว้' : ''}
          </span>
        </span>
        <span className="num shrink-0">{formatBaht(line.unitPriceSatang * line.qty)}</span>
      </button>
    </li>
  );
}

export function TotalsBlock({ order, draftTotal = 0 }: { order: Order; draftTotal?: number }) {
  const row = (label: string, v: number, cls?: string) => (
    <div className={clsx('flex justify-between', cls)}>
      <dt>{label}</dt>
      <dd className="num">{formatBaht(v)}</dd>
    </div>
  );
  return (
    <dl className="flex flex-col gap-0.5 text-sm">
      {row('รวม', order.subtotalSatang)}
      {order.discountSatang > 0 && row('ส่วนลด', -order.discountSatang, 'text-chili')}
      {order.serviceChargeSatang > 0 && row(`ค่าบริการ ${order.pricing.serviceChargeBps / 100}%`, order.serviceChargeSatang)}
      {order.vatSatang > 0 && row(order.pricing.vatMode === 'INCLUSIVE' ? `VAT ${order.pricing.vatBps / 100}% (รวมในราคา)` : `VAT ${order.pricing.vatBps / 100}%`, order.vatSatang)}
      <div className="mt-1 flex items-baseline justify-between border-t border-dashed border-line-strong pt-1.5 text-lg font-semibold">
        <dt>ยอดสุทธิ</dt>
        <dd className="num">{formatBaht(order.grandTotalSatang)}</dd>
      </div>
      {order.paidSatang > 0 && row('ชำระแล้ว', order.paidSatang, 'text-basil-600')}
      {draftTotal > 0 && <p className="text-xs text-sky">+ รายการยังไม่บันทึก {formatBaht(draftTotal)} (ยังไม่รวมภาษี/ค่าบริการ)</p>}
    </dl>
  );
}

/** Group server items by course for display. */
export function groupByCourse(items: OrderItem[]) {
  const map = new Map<number, OrderItem[]>();
  for (const i of items) map.set(i.course, [...(map.get(i.course) ?? []), i]);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([course, list]) => ({ course, label: COURSE[course] ?? `รอบ ${course}`, items: list }));
}
