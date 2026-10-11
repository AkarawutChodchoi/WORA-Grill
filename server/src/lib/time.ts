/** YYYY-MM-DD of `at` in the branch timezone (business day, assumption A4). */
export function businessDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Offset in minutes of `timeZone` from UTC at instant `at` (e.g. +420 for Bangkok). */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** UTC instant of local midnight starting `date` (YYYY-MM-DD) in `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const off = tzOffsetMinutes(timeZone, guess);
  const first = new Date(guess.getTime() - off * 60000);
  // Re-check in case the offset differs at the true instant (DST zones).
  const off2 = tzOffsetMinutes(timeZone, first);
  return off2 === off ? first : new Date(guess.getTime() - off2 * 60000);
}

/** Inclusive local date range → [fromUtc, toUtcExclusive). */
export function localRange(from: string, to: string, timeZone: string): [Date, Date] {
  return [startOfLocalDay(from, timeZone), startOfLocalDay(addDays(to, 1), timeZone)];
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
