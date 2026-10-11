import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RefreshCw } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Dialog } from '../components/ui';
import { offlineHooks } from './api';
import { IdbStore, isOfflineCapable, Outbox, type OutboxEntry } from './outbox';

/** Sends a queued entry with the same headers as the live API client. */
async function sendEntry(e: OutboxEntry) {
  try {
    const res = await fetch(`/api${e.path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rms' },
      body: JSON.stringify(e.body),
    });
    if (res.ok) return { ok: true as const };
    const err = await res.json().catch(() => null);
    // 401/408/429/5xx: try again later; other 4xx are business conflicts a person must resolve.
    const retry = res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500;
    return { ok: false as const, retry, error: err?.error?.message ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false as const, retry: true, error: 'ยังเชื่อมต่อไม่ได้' };
  }
}

export const outbox = new Outbox(new IdbStore(), sendEntry);

function labelFor(path: string, body: any): string {
  if (/\/items$/.test(path)) return `เพิ่ม ${body?.items?.length ?? ''} รายการ${body?.send ? ' และส่งครัว' : ''}`;
  if (/\/send$/.test(path)) return 'ส่งครัว';
  if (/\/payments$/.test(path)) return `รับเงินสด ${((body?.amountSatang ?? 0) / 100).toFixed(2)} บาท`;
  return 'เปิดบิลใหม่';
}

// Queue only idempotent POS writes; payments only when cash (never fake a card/QR confirmation offline).
offlineHooks.queue = async (path, body) => {
  if (!isOfflineCapable('POST', path)) return null;
  const b = body as Record<string, unknown>;
  if (/\/payments$/.test(path)) {
    if (b.method !== 'CASH') return null;
    b.offlineRecordedAt = new Date().toISOString();
  }
  const e = await outbox.enqueue(path, b, labelFor(path, b));
  return e.id;
};

interface OfflineCtx {
  online: boolean;
  entries: OutboxEntry[];
  syncNow: () => void;
}
const Ctx = createContext<OfflineCtx>({ online: true, entries: [], syncNow: () => undefined });

export function OfflineProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const refresh = useCallback(() => void outbox.entries().then(setEntries), []);
  const syncNow = useCallback(() => {
    void outbox.sync().then((r) => {
      if (r.sent) qc.invalidateQueries();
    });
  }, [qc]);

  useEffect(() => {
    refresh();
    const off = outbox.onChange(refresh);
    const up = () => {
      setOnline(true);
      syncNow();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    // Any successful API call means we are back: flush the queue.
    offlineHooks.onOnline = () => {
      setOnline(true);
      if (entries.some((e) => e.status === 'PENDING')) syncNow();
    };
    const t = setInterval(() => void outbox.entries().then((es) => es.some((e) => e.status === 'PENDING') && syncNow()), 15_000);
    return () => {
      off();
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(t);
    };
  }, [refresh, syncNow, entries]);

  const value = useMemo(() => ({ online, entries, syncNow }), [online, entries, syncNow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOffline() {
  return useContext(Ctx);
}

/** Header badge: offline state, queued writes and failed syncs that need attention. */
export function OfflineIndicator() {
  const { online, entries, syncNow } = useOffline();
  const [open, setOpen] = useState(false);
  const pending = entries.filter((e) => e.status === 'PENDING').length;
  const failed = entries.filter((e) => e.status === 'FAILED');
  if (online && !entries.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs font-medium ${failed.length ? 'bg-chili text-white' : 'bg-turmeric-50 text-turmeric-700'}`}
      >
        <CloudOff className="size-4" />
        {!online ? 'ออฟไลน์' : 'กำลังซิงก์'}
        {pending > 0 && ` · รอส่ง ${pending}`}
        {failed.length > 0 && ` · ไม่สำเร็จ ${failed.length}`}
      </button>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="ข้อมูลที่บันทึกในเครื่อง"
          footer={
            <>
              {failed.length > 0 && (
                <Button variant="outline" onClick={() => void outbox.retryFailed()}>
                  ลองส่งรายการที่ไม่สำเร็จอีกครั้ง
                </Button>
              )}
              <Button icon={<RefreshCw className="size-4" />} onClick={syncNow}>
                ซิงก์ตอนนี้
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-ink-2">
            รายการด้านล่างบันทึกในเครื่องนี้และยังไม่ได้รับการยืนยันจากเซิร์ฟเวอร์ เงินสดที่รับแบบออฟไลน์จะถูกยืนยันเมื่อซิงก์สำเร็จเท่านั้น
          </p>
          <ul className="flex flex-col gap-2">
            {entries.map((e) => (
              <li key={e.id} className="rounded-control border border-line p-2 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{e.label}</span>
                  <span className={e.status === 'FAILED' ? 'text-chili' : 'text-ink-3'}>{e.status === 'FAILED' ? 'ไม่สำเร็จ' : 'รอส่ง'}</span>
                </div>
                <div className="text-xs text-ink-3">
                  {new Date(e.createdAt).toLocaleTimeString('th-TH')} · {e.path}
                </div>
                {e.error && <div className="text-xs text-chili">{e.error}</div>}
                {e.status === 'FAILED' && (
                  <Button size="sm" variant="danger-ghost" className="mt-1" onClick={() => void outbox.discard(e.id)}>
                    ทิ้งรายการนี้ (แก้ไขที่หน้าบิลแทน)
                  </Button>
                )}
              </li>
            ))}
            {entries.length === 0 && <li className="text-ink-3">ไม่มีรายการค้าง</li>}
          </ul>
        </Dialog>
      )}
    </>
  );
}
