import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Bell, GlassWater, Minus, Plus, Receipt, ShoppingBasket, Snowflake, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { unitPriceWithModifiers, validateModifiers } from '@shared/menu';
import { formatBaht } from '@shared/money';
import { Button, Dialog, ErrorState, LoadingBlock, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import type { MenuItem } from '../menu/types';
import { ALLERGEN_I18N, localName, t, type Lang } from './i18n';

interface GuestData {
  branchName: string;
  tableName: string | null;
  orderNo: string;
  orderOpen: boolean;
  orderingEnabled: boolean;
  requiresApproval: boolean;
  menu: { categories: { id: string; name: string; nameEn: string | null; nameZh: string | null }[]; items: MenuItem[] };
  order: { items: { id: string; name: string; nameEn: string | null; qty: number; status: string; unitPriceSatang: number; modifiers: { name: string; qty: number }[]; note: string | null; awaitingApproval: boolean }[]; grandTotalSatang: number; dueSatang: number; status: string };
  payment: { promptPay: boolean };
}

interface CartLine {
  id: string;
  item: MenuItem;
  qty: number;
  mods: Record<string, number>;
  note: string;
}

const LANG_KEY = 'rms.guest.lang';

function GuestItemDialog({ item, lang, onClose, onAdd }: { item: MenuItem; lang: Lang; onClose: () => void; onAdd: (l: Omit<CartLine, 'id'>) => void }) {
  const L = t(lang);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [mods, setMods] = useState<Record<string, number>>(() => Object.fromEntries(item.modifierGroups.flatMap((g) => g.modifiers.filter((m) => m.isDefault).map((m) => [m.id, 1]))));
  const selected = Object.entries(mods).map(([modifierId, q]) => ({ modifierId, qty: q }));
  const v = validateModifiers(item.modifierGroups, selected);
  const unit = v.ok ? unitPriceWithModifiers(item.priceSatang, v.modifiers) : item.priceSatang;
  const toggle = (gId: string, mId: string) => {
    const g = item.modifierGroups.find((x) => x.id === gId)!;
    setMods((p) => {
      const n = { ...p };
      if (g.maxSelect === 1) {
        g.modifiers.forEach((m) => delete n[m.id]);
        if (!p[mId]) n[mId] = 1;
      } else if (n[mId]) delete n[mId];
      else n[mId] = 1;
      return n;
    });
  };
  return (
    <Dialog open onClose={onClose} title={localName(lang, item)} size="md">
      {item.imageUrl && <img src={item.imageUrl} alt="" className="mb-3 h-48 w-full rounded-control object-cover" />}
      {(lang === 'en' ? item.descriptionEn : lang === 'zh' ? item.descriptionZh : null) || item.description ? (
        <p className="mb-3 text-sm text-ink-2">{(lang === 'en' ? item.descriptionEn : lang === 'zh' ? item.descriptionZh : null) || item.description}</p>
      ) : null}
      {item.allergens.length > 0 && (
        <p className="mb-3 flex items-center gap-1 text-sm font-medium text-chili">
          <AlertTriangle className="size-4" /> {L.allergens}: {item.allergens.map((a) => ALLERGEN_I18N[a]?.[lang] ?? a).join(', ')}
        </p>
      )}
      {item.modifierGroups.map((g) => (
        <fieldset key={g.id} className="mb-3">
          <legend className="mb-1 font-medium">
            {localName(lang, g)}{' '}
            <span className="text-sm font-normal text-ink-3">{g.minSelect > 0 ? L.required : g.maxSelect ? `${L.choose} ${g.maxSelect}` : ''}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {g.modifiers.map((m) => (
              <button key={m.id} type="button" aria-pressed={!!mods[m.id]} onClick={() => toggle(g.id, m.id)} className={clsx('min-h-11 rounded-full border px-4', mods[m.id] ? 'border-basil bg-basil text-white' : 'border-line-strong')}>
                {localName(lang, m)}
                {m.priceDeltaSatang !== 0 && ` +${formatBaht(m.priceDeltaSatang)}`}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <label className="mb-3 block">
        <span className="text-sm text-ink-2">{L.note}</span>
        <input value={note} maxLength={150} onChange={(e) => setNote(e.target.value)} className="mt-1 h-11 w-full rounded-control border border-line-strong px-3" />
      </label>
      {!v.ok && <p className="mb-2 text-sm text-chili">{v.errors.join(' · ')}</p>}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="lg" aria-label="-" icon={<Minus className="size-5" />} onClick={() => setQty(Math.max(1, qty - 1))} />
        <span className="num w-8 text-center text-xl font-semibold">{qty}</span>
        <Button variant="outline" size="lg" aria-label="+" icon={<Plus className="size-5" />} onClick={() => setQty(Math.min(20, qty + 1))} />
        <Button size="lg" className="flex-1" disabled={!v.ok} onClick={() => onAdd({ item, qty, mods, note })}>
          {L.add} · {formatBaht(unit * qty)}
        </Button>
      </div>
    </Dialog>
  );
}

/** Customer QR menu (SPEC §3.4). Works on any phone browser; no app or login required. */
export function GuestMenuPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [lang, setLang] = useState<Lang>(() => {
    try {
      return (localStorage.getItem(LANG_KEY) as Lang) || (navigator.language.startsWith('zh') ? 'zh' : navigator.language.startsWith('th') ? 'th' : 'en');
    } catch {
      return 'th';
    }
  });
  const L = t(lang);
  const [cat, setCat] = useState('all');
  const [picking, setPicking] = useState<MenuItem | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [pay, setPay] = useState<{ dataUrl: string; amountSatang: number } | null>(null);
  const q = useQuery({ queryKey: ['guest', token], queryFn: () => get<GuestData>(`/public/qr/${token}`), refetchInterval: 20_000, retry: false });

  useEffect(() => {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  // Live updates for this bill only.
  useEffect(() => {
    if (!q.data?.orderOpen) return;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/public/ws?token=${encodeURIComponent(token)}`);
      ws.onmessage = () => qc.invalidateQueries({ queryKey: ['guest', token] });
    } catch {
      /* polling continues */
    }
    return () => ws?.close();
  }, [token, q.data?.orderOpen, qc]);

  const submit = useMutation({
    mutationFn: () =>
      post<{ added: number; requiresApproval: boolean }>(`/public/qr/${token}/items`, {
        items: cart.map((c) => ({ id: c.id, menuItemId: c.item.id, qty: c.qty, modifiers: Object.entries(c.mods).map(([modifierId, qty]) => ({ modifierId, qty })), note: c.note || undefined })),
      }),
    onSuccess: (r) => {
      setCart([]);
      setCartOpen(false);
      toast.success(r.requiresApproval ? L.awaiting : L.ordered);
      qc.invalidateQueries({ queryKey: ['guest', token] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const request = useMutation({
    mutationFn: (type: string) => post(`/public/qr/${token}/requests`, { type }),
    onSuccess: () => toast.success(L.sent),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const cartTotal = useMemo(
    () =>
      cart.reduce((a, c) => {
        const v = validateModifiers(c.item.modifierGroups, Object.entries(c.mods).map(([modifierId, qty]) => ({ modifierId, qty })));
        return a + (v.ok ? unitPriceWithModifiers(c.item.priceSatang, v.modifiers) : c.item.priceSatang) * c.qty;
      }, 0),
    [cart],
  );

  if (q.isLoading) return <div className="p-4"><LoadingBlock /></div>;
  if (q.error || !q.data) return <div className="p-4"><ErrorState error={q.error} /></div>;
  const d = q.data;
  if (!d.orderOpen) return <p className="p-8 text-center text-lg">{L.closed}</p>;
  const items = d.menu.items.filter((i) => cat === 'all' || i.categoryId === cat);

  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-28">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="font-semibold">{d.branchName}</h1>
            <p className="text-sm text-ink-2">
              {d.tableName ? `${L.table} ${d.tableName}` : `${L.order} #${d.orderNo}`}
            </p>
          </div>
          <div className="flex gap-1" role="group" aria-label="Language">
            {(['th', 'en', 'zh'] as Lang[]).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)} aria-pressed={lang === l} className={clsx('rounded px-2 py-1 text-sm', lang === l ? 'bg-ink text-white' : 'bg-sunken')}>
                {l === 'th' ? 'ไทย' : l === 'en' ? 'EN' : '中文'}
              </button>
            ))}
          </div>
        </div>
        <nav className="-mx-4 mt-2 flex gap-1 overflow-x-auto px-4" aria-label="categories">
          {[{ id: 'all', name: L.all, nameEn: L.all, nameZh: L.all }, ...d.menu.categories].map((c) => (
            <button key={c.id} type="button" onClick={() => setCat(c.id)} className={clsx('rounded-full px-3 py-1.5 text-sm whitespace-nowrap', cat === c.id ? 'bg-basil text-white' : 'bg-sunken')}>
              {localName(lang, c)}
            </button>
          ))}
        </nav>
      </header>

      {!d.orderingEnabled && <p className="m-4 rounded-control bg-turmeric-50 p-3 text-sm">{L.orderingOff}</p>}

      <ul className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              disabled={!i.available || !d.orderingEnabled}
              onClick={() => setPicking(i)}
              className="flex w-full gap-3 overflow-hidden rounded-panel border border-line bg-surface text-left disabled:opacity-60"
            >
              {i.imageUrl ? <img src={i.imageUrl} alt="" className="h-24 w-24 shrink-0 object-cover" loading="lazy" /> : <div className="h-24 w-2 shrink-0 bg-basil-50" />}
              <span className="flex min-w-0 flex-1 flex-col py-2 pr-3">
                <span className="font-medium">{localName(lang, i)}</span>
                {i.allergens.length > 0 && <span className="text-xs text-chili">{i.allergens.map((a) => ALLERGEN_I18N[a]?.[lang] ?? a).join(', ')}</span>}
                <span className="num mt-auto font-semibold text-basil-600">{i.available ? formatBaht(i.priceSatang) : i.soldOut ? L.soldOut : L.unavailable}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="px-4 text-xs text-ink-3">{L.prices}</p>

      {d.order.items.length > 0 && (
        <section className="m-4 rounded-panel border border-line bg-surface p-4" aria-live="polite">
          <h2 className="mb-2 font-semibold">{L.myOrder}</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {d.order.items.map((i) => (
              <li key={i.id} className={clsx('flex justify-between gap-2', i.status === 'CANCELLED' && 'line-through opacity-50')}>
                <span>
                  {i.qty}× {lang === 'th' ? i.name : i.nameEn || i.name}
                  {i.modifiers.length > 0 && <span className="text-ink-3"> ({i.modifiers.map((m) => m.name).join(', ')})</span>}
                </span>
                <span className={clsx('shrink-0 rounded px-1.5 text-xs', i.status === 'READY' ? 'bg-basil-50 text-basil-600' : i.status === 'PREPARING' ? 'bg-turmeric-50' : 'bg-sunken')}>{L.status[i.status] ?? i.status}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between border-t border-line pt-2 font-semibold">
            <span>{L.total}</span>
            <span className="num">{formatBaht(d.order.grandTotalSatang)}</span>
          </div>
          {d.payment.promptPay && d.order.dueSatang > 0 && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={async () => {
                try {
                  setPay(await get(`/public/qr/${token}/promptpay`));
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              {L.payPromptPay}
            </Button>
          )}
        </section>
      )}

      <div className="mx-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['CALL_WAITER', L.callWaiter, Bell],
          ['WATER', L.water, GlassWater],
          ['ICE', L.ice, Snowflake],
          ['BILL', L.bill, Receipt],
        ].map(([type, label, Icon]: any) => (
          <Button key={type} variant="outline" icon={<Icon className="size-4" />} loading={request.isPending && request.variables === type} onClick={() => request.mutate(type)}>
            {label}
          </Button>
        ))}
      </div>

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface p-3">
          <Button size="lg" className="mx-auto flex w-full max-w-2xl" icon={<ShoppingBasket className="size-5" />} onClick={() => setCartOpen(true)}>
            {L.cart} ({cart.reduce((a, c) => a + c.qty, 0)}) · <span className="num">{formatBaht(cartTotal)}</span>
          </Button>
        </div>
      )}

      {picking && (
        <GuestItemDialog
          item={picking}
          lang={lang}
          onClose={() => setPicking(null)}
          onAdd={(l) => {
            setCart((c) => [...c, { ...l, id: crypto.randomUUID() }]);
            setPicking(null);
          }}
        />
      )}
      {cartOpen && (
        <Dialog
          open
          onClose={() => setCartOpen(false)}
          title={L.cart}
          footer={
            <Button size="lg" className="w-full" loading={submit.isPending} disabled={cart.length === 0} onClick={() => submit.mutate()}>
              {L.sendOrder} · {formatBaht(cartTotal)}
            </Button>
          }
        >
          {cart.length === 0 ? (
            <p className="text-ink-3">{L.empty}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {cart.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <span className="flex-1">
                    {c.qty}× {localName(lang, c.item)}
                    {c.note && <span className="block text-xs text-ink-3">{c.note}</span>}
                  </span>
                  <button type="button" aria-label="remove" className="rounded p-2 hover:bg-sunken" onClick={() => setCart(cart.filter((x) => x.id !== c.id))}>
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {d.requiresApproval && <p className="mt-3 text-xs text-ink-3">{L.awaiting}</p>}
        </Dialog>
      )}
      {pay && (
        <Dialog open onClose={() => setPay(null)} title={L.payPromptPay} size="sm">
          <div className="flex flex-col items-center gap-2">
            <img src={pay.dataUrl} alt="PromptPay QR" className="size-64" />
            <p className="num text-2xl font-semibold">{formatBaht(pay.amountSatang)}</p>
            <p className="text-center text-sm text-ink-2">{L.payNote}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
