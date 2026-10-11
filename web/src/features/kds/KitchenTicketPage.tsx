import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ALLERGENS } from '@shared/menu';
import { Button, ErrorState, LoadingBlock } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { CHANNEL_LABEL } from '../menu/ItemDialog';
import type { OrderItem } from '../pos/types';

interface KitchenTicketData {
  orderNo: string;
  channel: string;
  tableName: string | null;
  guestCount: number;
  customerName: string | null;
  note: string | null;
  printedAt: string;
  tickets: { station: string; stationName: string; items: OrderItem[] }[];
}

/** Printable kitchen order slips, one per station (fallback when a KDS screen is unavailable). */
export function KitchenTicketPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ['kitchen-ticket', id, params.toString()],
    queryFn: () => get<KitchenTicketData>(`/orders/${id}/kitchen-ticket${qs({ itemIds: params.get('itemIds'), station: params.get('station') })}`),
  });
  if (q.isLoading) return <div className="p-6"><LoadingBlock /></div>;
  if (q.error || !q.data) return <div className="p-6"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const d = q.data;
  return (
    <div className="min-h-dvh bg-sunken py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-md justify-between px-3">
        <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => nav(-1)}>
          กลับ
        </Button>
        <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
          พิมพ์
        </Button>
      </div>
      {d.tickets.length === 0 && <p className="text-center text-ink-2">ไม่มีรายการที่ต้องพิมพ์</p>}
      {d.tickets.map((t) => (
        <article key={t.station} className="mx-auto mb-6 w-[80mm] bg-white p-3 text-black [break-after:page] print:mb-0">
          <header className="border-b-2 border-black pb-1 text-center">
            <p className="text-sm">{t.stationName}</p>
            <h1 className="text-2xl font-bold">{d.tableName ? `โต๊ะ ${d.tableName}` : (CHANNEL_LABEL[d.channel] ?? d.channel)}</h1>
            <p className="text-sm">
              #{d.orderNo} · {d.guestCount} คน · {fmtDateTime(d.printedAt)}
            </p>
            {d.customerName && <p>{d.customerName}</p>}
            {d.note && <p className="font-semibold">{d.note}</p>}
          </header>
          <ul className="mt-2 flex flex-col gap-2">
            {t.items.map((i) => (
              <li key={i.id} className="border-b border-dashed border-black pb-1">
                <p className="text-lg font-bold">
                  {i.qty} × {i.nameSnapshot} {i.course > 1 && <span className="text-sm">[รอบ {i.course}]</span>}
                </p>
                {i.modifiers.map((m, k) => (
                  <p key={k} className="pl-4">
                    + {m.name}
                    {m.qty > 1 && ` ×${m.qty}`}
                  </p>
                ))}
                {i.note && <p className="pl-4 font-bold">** {i.note} **</p>}
                {i.allergens.length > 0 && <p className="pl-4 font-bold">!! แพ้: {i.allergens.map((a) => ALLERGENS[a] ?? a).join(', ')}</p>}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}
