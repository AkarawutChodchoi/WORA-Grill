/**
 * Offline outbox (SPEC §3.17 Offline mode). Writes that the POS may need while the network is down are
 * queued locally with their client-generated ids and replayed in order when the connection returns.
 * Every queued request is idempotent on the server (client ids for orders, lines and payments), so
 * retries never duplicate orders, payments or stock deductions.
 */

export interface OutboxEntry {
  id: string;
  method: 'POST';
  path: string;
  body: unknown;
  label: string;
  createdAt: number;
  attempts: number;
  status: 'PENDING' | 'FAILED';
  error?: string;
}

export interface OutboxStore {
  all(): Promise<OutboxEntry[]>;
  put(e: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryStore implements OutboxStore {
  private m = new Map<string, OutboxEntry>();
  async all() {
    return [...this.m.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(e: OutboxEntry) {
    this.m.set(e.id, { ...e });
  }
  async remove(id: string) {
    this.m.delete(id);
  }
}

/** IndexedDB-backed store; falls back to memory when IndexedDB is unavailable (private mode, tests). */
export class IdbStore implements OutboxStore {
  private dbp: Promise<IDBDatabase> | null = null;
  private fallback = new MemoryStore();
  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('rms-offline', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const r = fn(db.transaction('outbox', mode).objectStore('outbox'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async all() {
    try {
      return ((await this.tx('readonly', (s) => s.getAll())) as OutboxEntry[]).sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      return this.fallback.all();
    }
  }
  async put(e: OutboxEntry) {
    try {
      await this.tx('readwrite', (s) => s.put(e));
    } catch {
      await this.fallback.put(e);
    }
  }
  async remove(id: string) {
    try {
      await this.tx('readwrite', (s) => s.delete(id));
    } catch {
      await this.fallback.remove(id);
    }
  }
}

export type Sender = (e: OutboxEntry) => Promise<{ ok: true } | { ok: false; retry: boolean; error: string }>;

/** Requests that may be queued while offline. Payments only for cash (handled by the caller). */
export function isOfflineCapable(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  return /^\/orders$/.test(path) || /^\/orders\/[\w-]+\/(items|send|payments)$/.test(path);
}

export class Outbox {
  private listeners = new Set<() => void>();
  private syncing = false;
  constructor(
    private store: OutboxStore,
    private send: Sender,
  ) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }

  async enqueue(path: string, body: unknown, label: string) {
    const e: OutboxEntry = { id: crypto.randomUUID(), method: 'POST', path, body, label, createdAt: Date.now(), attempts: 0, status: 'PENDING' };
    await this.store.put(e);
    this.emit();
    return e;
  }

  entries() {
    return this.store.all();
  }

  async discard(id: string) {
    await this.store.remove(id);
    this.emit();
  }

  async retryFailed() {
    for (const e of await this.store.all()) if (e.status === 'FAILED') await this.store.put({ ...e, status: 'PENDING', error: undefined });
    this.emit();
    return this.sync();
  }

  /**
   * Replay pending entries in order. Network failures stop the run (try later). A rejection by the server
   * (e.g. table taken, bill already paid) marks the entry FAILED for a person to resolve; later entries
   * for the same order are held back so they cannot apply out of order.
   */
  async sync(): Promise<{ sent: number; failed: number; remaining: number }> {
    if (this.syncing) return { sent: 0, failed: 0, remaining: (await this.store.all()).length };
    this.syncing = true;
    let sent = 0;
    let failed = 0;
    try {
      const blockedOrders = new Set<string>();
      for (const e of await this.store.all()) {
        const orderKey = /^\/orders\/([\w-]+)/.exec(e.path)?.[1] ?? (e.body as { id?: string })?.id;
        if (e.status === 'FAILED') {
          if (orderKey) blockedOrders.add(orderKey);
          continue;
        }
        if (orderKey && blockedOrders.has(orderKey)) continue;
        const r = await this.send(e);
        if (r.ok) {
          await this.store.remove(e.id);
          sent++;
        } else if (r.retry) {
          await this.store.put({ ...e, attempts: e.attempts + 1, error: r.error });
          break;
        } else {
          await this.store.put({ ...e, attempts: e.attempts + 1, status: 'FAILED', error: r.error });
          if (orderKey) blockedOrders.add(orderKey);
          failed++;
        }
      }
    } finally {
      this.syncing = false;
      this.emit();
    }
    return { sent, failed, remaining: (await this.store.all()).length };
  }
}
