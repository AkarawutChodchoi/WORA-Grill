import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
  /** Phone card layout: 'title' = card heading (default: first column), 'media' = thumbnail beside the heading, 'hide' = not shown on phones. */
  mobile?: 'title' | 'media' | 'hide';
}

// Literal class names so Tailwind generates them.
const STACK = { sm: ['sm:hidden', 'sm:block'], md: ['md:hidden', 'md:block'], lg: ['lg:hidden', 'lg:block'], xl: ['xl:hidden', 'xl:block'] } as const;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  caption,
  emptyText = 'ยังไม่มีรายการ',
  stackBelow = 'sm',
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  caption?: string;
  /** Shown instead of an empty table. */
  emptyText?: string;
  /** Width below which rows show as cards (wide tables with many actions should stack on tablets too). */
  stackBelow?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const [cardsClass, tableClass] = STACK[stackBelow];
  if (rows.length === 0) return <p className="rounded-panel border border-dashed border-line-strong bg-surface px-4 py-8 text-center text-ink-3">{emptyText}</p>;
  // Phones get one card per row instead of a table that only scrolls sideways.
  const mediaCol = columns.find((c) => c.mobile === 'media');
  const titleCol = columns.find((c) => c.mobile === 'title') ?? columns.find((c) => c !== mediaCol)!;
  const isAction = (c: Column<T>) => c.header === '' || c.header == null;
  const rest = columns.filter((c) => c !== titleCol && c !== mediaCol && c.mobile !== 'hide');
  const fields = rest.filter((c) => !isAction(c));
  const actions = rest.filter(isAction);
  return (
    <>
      <ul className={clsx('divide-y divide-line rounded-panel border border-line bg-surface', cardsClass)} aria-label={caption}>
        {rows.map((r) => (
          <li
            key={rowKey(r)}
            className={clsx('flex flex-col gap-1 px-3 py-3', onRowClick && 'cursor-pointer active:bg-sunken/60')}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
            tabIndex={onRowClick ? 0 : undefined}
          >
            <div className="flex items-center gap-3">
              {mediaCol && <div className="shrink-0">{mediaCol.cell(r)}</div>}
              <div className="min-w-0 font-medium">{titleCol.cell(r)}</div>
            </div>
            {fields.map((c) => (
              <div key={c.key} className="flex items-start justify-between gap-3 text-sm">
                <span className="shrink-0 text-ink-3">{c.header}</span>
                <span className={clsx('min-w-0 text-right', c.align === 'right' && 'num')}>{c.cell(r)}</span>
              </div>
            ))}
            {actions.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                {actions.map((c) => (
                  <span key={c.key}>{c.cell(r)}</span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className={clsx('hidden overflow-x-auto rounded-panel border border-line bg-surface', tableClass)}>
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
    </>
  );
}
