import { useId, useState } from 'react';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
}

/**
 * Single-series vertical bar chart: one hue (basil), thin bars with rounded data-ends on a zero
 * baseline, recessive grid, per-bar hover/focus tooltip, and an always-available table view.
 */
export function BarChart({ data, format, height = 200, title, emptyText = 'ไม่มีข้อมูลในช่วงนี้' }: { data: BarDatum[]; format: (v: number) => string; height?: number; title: string; emptyText?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const max = Math.max(0, ...data.map((d) => d.value));
  if (data.length === 0 || max === 0) return <p className="py-6 text-center text-sm text-ink-3">{emptyText}</p>;
  const W = 640;
  const pad = { l: 8, r: 8, t: 12, b: 24 };
  const innerH = height - pad.t - pad.b;
  const step = (W - pad.l - pad.r) / data.length;
  const bw = Math.max(4, Math.min(28, step * 0.6));
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const labelEvery = Math.ceil(data.length / 12);
  return (
    <figure className="relative">
      <div className="mb-1 flex justify-end">
        <button type="button" className="text-xs text-sky hover:underline" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? 'ดูกราฟ' : 'ดูเป็นตาราง'}
        </button>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <caption className="sr-only">{title}</caption>
          <tbody>
            {data.map((d) => (
              <tr key={d.key} className="border-b border-line last:border-0">
                <th scope="row" className="py-1 text-left font-normal">
                  {d.label}
                </th>
                <td className="num py-1 text-right">{format(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}>
          <title id={`${id}-t`}>{title}</title>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-line)" strokeWidth={1} />
          ))}
          <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" strokeWidth={1} />
          {data.map((d, i) => {
            const cx = pad.l + step * i + step / 2;
            const top = y(d.value);
            const h = Math.max(0, y(0) - top);
            const r = Math.min(4, bw / 2, h);
            return (
              <g key={d.key}>
                {/* hit target larger than the mark */}
                <rect
                  x={pad.l + step * i}
                  y={pad.t}
                  width={step}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${d.label}: ${format(d.value)}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
                {h > 0 && (
                  <path
                    d={`M${cx - bw / 2},${y(0)} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${y(0)} Z`}
                    fill={hover === i ? 'var(--color-basil-600)' : 'var(--color-basil)'}
                    pointerEvents="none"
                  />
                )}
                {i % labelEvery === 0 && (
                  <text x={cx} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--color-ink-3)">
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {!table && hover !== null && (
        <div
          className="pointer-events-none absolute top-6 rounded-control bg-ink px-2 py-1 text-xs whitespace-nowrap text-white shadow"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%`, transform: 'translateX(-50%)' }}
          role="status"
        >
          {data[hover].label}: <span className="num">{format(data[hover].value)}</span>
        </div>
      )}
    </figure>
  );
}

/** Horizontal labelled bars for breakdowns (channel, payment method): text carries identity. */
export function BarList({ items, format }: { items: { key: string; label: string; value: number; sub?: string }[]; format: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="text-sm text-ink-3">ไม่มีข้อมูล</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((i) => (
        <li key={i.key}>
          <div className="flex justify-between gap-2 text-sm">
            <span>
              {i.label} {i.sub && <span className="text-ink-3">{i.sub}</span>}
            </span>
            <span className="num">{format(i.value)}</span>
          </div>
          <div className="mt-0.5 h-2 rounded-full bg-sunken">
            <div className="h-2 rounded-full bg-basil" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
