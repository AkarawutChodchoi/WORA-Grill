import { clsx } from 'clsx';
import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../../lib/api';
import { Button } from './Button';

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded bg-line/70', className ?? 'h-4 w-full')} aria-hidden />;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 py-2" role="status" aria-label="กำลังโหลด">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={clsx('h-9', i % 2 ? 'w-11/12' : 'w-full')} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <div className="text-ink-3">{icon ?? <Inbox className="size-8" />}</div>
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-panel border border-chili/30 bg-chili-50 px-4 py-8 text-center" role="alert">
      <AlertTriangle className="size-7 text-chili" />
      <p className="font-medium text-chili">โหลดข้อมูลไม่สำเร็จ</p>
      <p className="text-sm text-ink-2">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          ลองอีกครั้ง
        </Button>
      )}
    </div>
  );
}

/** Renders loading / error / empty / content states for a react-query result. */
export function QueryView<T>({
  query,
  empty,
  isEmpty,
  children,
}: {
  query: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  empty?: ReactNode;
  isEmpty?: (d: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <LoadingBlock />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined) return null;
  if (empty && isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
