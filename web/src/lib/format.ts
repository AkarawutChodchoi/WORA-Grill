import { formatBaht } from '@shared/money';
export { formatBaht };

const tz = 'Asia/Bangkok';
export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('th-TH', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '—';
export const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString('th-TH', { timeZone: tz, dateStyle: 'medium' }) : '—';
export const fmtTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleTimeString('th-TH', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : '—';

export function elapsedMinutes(from: string | Date, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000));
}
export function fmtElapsed(from: string | Date, now = Date.now()): string {
  const m = elapsedMinutes(from, now);
  return m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} น.`;
}
/** Today's date (YYYY-MM-DD) in Bangkok. */
export function todayISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}
