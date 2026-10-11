export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Thrown when a write was saved to the offline outbox instead of reaching the server. */
export class OfflineQueuedError extends Error {
  constructor(public entryId: string) {
    super('ออฟไลน์อยู่ — บันทึกไว้ในเครื่องแล้ว จะส่งให้เซิร์ฟเวอร์อัตโนมัติเมื่อกลับมาออนไลน์');
  }
}

/** Set by lib/offline.tsx so the API layer can queue writes without importing UI code. */
export const offlineHooks: { queue: ((path: string, body: unknown) => Promise<string | null>) | null; onOnline: (() => void) | null } = { queue: null, onOnline: null };

export async function api<T = unknown>(method: Method, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'rms',
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      ...init,
    });
  } catch {
    if (method === 'POST' && offlineHooks.queue && !(body instanceof FormData)) {
      const entryId = await offlineHooks.queue(path, body);
      if (entryId) throw new OfflineQueuedError(entryId);
    }
    throw new ApiError(0, 'NETWORK', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง');
  }
  offlineHooks.onOnline?.();
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (data as any)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export const get = <T,>(p: string) => api<T>('GET', p);
export const post = <T,>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T,>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {});
export const patch = <T,>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const del = <T,>(p: string) => api<T>('DELETE', p);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
