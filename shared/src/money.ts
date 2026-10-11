/**
 * Money is always an integer number of satang (1 THB = 100 satang).
 * Rates are integer basis points (1% = 100 bps, VAT 7% = 700 bps).
 * Never use floating point for money.
 */
export type Satang = number;
export type Bps = number;

export function assertSatang(v: number, label = 'amount'): Satang {
  if (!Number.isSafeInteger(v)) throw new Error(`${label} must be an integer number of satang`);
  return v;
}

/** Round a rational a/b to the nearest integer, halves away from zero (b > 0). */
export function divRound(a: number, b: number): number {
  if (b <= 0 || !Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new Error('divRound: invalid operands');
  const sign = a < 0 ? -1 : 1;
  const abs = Math.abs(a);
  const q = Math.floor(abs / b);
  const r = abs - q * b;
  return sign * (r * 2 >= b ? q + 1 : q);
}

/** amount × bps / 10000, rounded half-up. */
export function applyBps(amount: Satang, bps: Bps): Satang {
  return divRound(amount * bps, 10_000);
}

/** Portion of a VAT-inclusive amount that is VAT: amount × rate / (10000 + rate). */
export function vatFromInclusive(amount: Satang, bps: Bps): Satang {
  return divRound(amount * bps, 10_000 + bps);
}

/** Parse "123.45" / "123" / 123.45 user input into satang without float error. */
export function toSatang(input: string | number): Satang {
  const s = typeof input === 'number' ? input.toFixed(2) : input.trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid money value: ${input}`);
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -v : v;
}

export function formatBaht(v: Satang, opts: { symbol?: boolean } = {}): string {
  const neg = v < 0;
  const abs = Math.abs(v);
  const baht = Math.floor(abs / 100).toLocaleString('en-US');
  const s = `${baht}.${String(abs % 100).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${opts.symbol === false ? '' : '฿'}${s}`;
}

/** Split `total` into `parts` integer pieces that sum exactly to total (remainder spread to first parts). */
export function splitEvenly(total: Satang, parts: number): Satang[] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error('parts must be >= 1');
  const base = Math.trunc(total / parts);
  let rem = total - base * parts;
  return Array.from({ length: parts }, () => {
    const extra = rem > 0 ? 1 : rem < 0 ? -1 : 0;
    rem -= extra;
    return base + extra;
  });
}

/** Allocate `total` proportionally to `weights` (largest-remainder method); result sums exactly to total. */
export function allocate(total: Satang, weights: number[]): Satang[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum === 0) return splitEvenly(total, weights.length);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let rem = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rem <= 0) break;
    floors[i] += 1;
    rem -= 1;
  }
  return floors;
}
