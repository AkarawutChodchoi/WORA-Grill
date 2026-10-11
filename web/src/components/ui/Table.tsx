import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  caption?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line bg-sunken/60 text-left text-ink-2">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={clsx('px-3 py-2 font-medium whitespace-nowrap', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              className={clsx('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-sunken/50')}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={clsx('px-3 py-2 align-middle', c.align === 'right' && 'num text-right', c.align === 'center' && 'text-center', c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
