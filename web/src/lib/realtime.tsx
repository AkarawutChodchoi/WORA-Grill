import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './auth';

export interface RealtimeEvent {
  type: string;
  payload: Record<string, any>;
  at?: string;
}

type Listener = (e: RealtimeEvent) => void;

interface RealtimeCtx {
  connected: boolean;
  subscribe: (fn: Listener) => () => void;
}

const Ctx = createContext<RealtimeCtx>({ connected: false, subscribe: () => () => undefined });

/** Map server events to the react-query caches they make stale. */
export function invalidateFor(qc: QueryClient, e: RealtimeEvent) {
  const inv = (key: unknown[]) => qc.invalidateQueries({ queryKey: key });
  switch (e.type) {
    case 'table.status_changed':
      inv(['tables']);
      break;
    case 'order.created':
    case 'order.updated':
    case 'payment.confirmed':
      inv(['tables']);
      inv(['orders']);
      if (e.payload.orderId) inv(['order', e.payload.orderId]);
      inv(['kds']);
      break;
    case 'order_item.status_changed':
    case 'kitchen.ticket':
      inv(['kds']);
      inv(['tables']);
      if (e.payload.orderId) inv(['order', e.payload.orderId]);
      break;
    case 'menu.sold_out':
    case 'menu.updated':
      inv(['menu']);
      inv(['menu-admin']);
      break;
    case 'call_waiter':
    case 'service_request.updated':
      inv(['service-requests']);
      inv(['qr-pending']);
      break;
    case 'reservation.updated':
    case 'waitlist.updated':
      inv(['reservations']);
      inv(['waitlist']);
      break;
    case 'stock.low':
    case 'notification':
      inv(['notifications']);
      break;
  }
}

/**
 * One WebSocket per signed-in tab. Reconnects with backoff; while disconnected, screens fall back to
 * polling (see `useLivePolling`). On reconnect everything is refetched so no event is lost.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const branchId = me?.branch?.id;

  useEffect(() => {
    if (!me || typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      ws.onopen = () => {
        if (attempt > 0) qc.invalidateQueries();
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as RealtimeEvent;
          invalidateFor(qc, e);
          listeners.current.forEach((fn) => fn(e));
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = (ev) => {
        setConnected(false);
        if (stopped || ev.code === 4401) return;
        attempt += 1;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [me?.user.id, branchId, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime() {
  return useContext(Ctx);
}

export function useRealtimeEvent(fn: Listener) {
  const { subscribe } = useRealtime();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

/** Poll interval to use for live screens: slow when the socket is up, faster as a fallback when it is down. */
export function useLivePolling(): number {
  const { connected } = useRealtime();
  return connected ? 60_000 : 10_000;
}

export function LiveIndicator() {
  const { connected } = useRealtime();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-3" title={connected ? 'อัปเดตแบบเรียลไทม์' : 'ขาดการเชื่อมต่อเรียลไทม์ — รีเฟรชทุก 10 วินาที'}>
      <span className={`size-2 rounded-full ${connected ? 'bg-basil' : 'bg-turmeric'}`} />
      <span className={connected ? 'hidden sm:inline' : undefined}>{connected ? 'สด' : 'ออฟไลน์เรียลไทม์'}</span>
    </span>
  );
}
