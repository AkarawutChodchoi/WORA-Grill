import { and, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { diningTables, orders, qrSessions, reservations, waitlistEntries } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { conflict } from '../../lib/errors';
import { branchSettings } from '../menu/service';

/** Issue a QR ordering token for an open order. Previous tokens of that order are revoked (rotation). */
export async function issueQrSession(db: DbOrTx, p: { orgId: string; branchId: string; orderId: string; tableId: string | null; createdBy: string | null }) {
  const s = await branchSettings(db, p.branchId);
  const token = randomToken(24);
  await db.update(qrSessions).set({ revokedAt: new Date() }).where(and(eq(qrSessions.orderId, p.orderId), isNull(qrSessions.revokedAt)));
  const expiresAt = new Date(Date.now() + s.qrTokenTtlMinutes * 60_000);
  await db.insert(qrSessions).values({ organizationId: p.orgId, branchId: p.branchId, orderId: p.orderId, tableId: p.tableId, tokenHash: sha256(token), expiresAt, createdBy: p.createdBy });
  return { token, expiresAt };
}

/** Resolve a guest token → session + order, only while it is valid and its order is still open. */
export async function loadQrSession(db: DbOrTx, token: string) {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const [row] = await db
    .select({ s: qrSessions, o: orders, tableName: diningTables.name })
    .from(qrSessions)
    .innerJoin(orders, eq(orders.id, qrSessions.orderId))
    .leftJoin(diningTables, eq(diningTables.id, qrSessions.tableId))
    .where(and(eq(qrSessions.tokenHash, sha256(token)), isNull(qrSessions.revokedAt), gt(qrSessions.expiresAt, new Date())));
  if (!row) return null;
  return { session: row.s, order: row.o, tableName: row.tableName, orderOpen: ['OPEN', 'BILL_REQUESTED'].includes(row.o.status) };
}

export async function revokeQrForOrder(db: DbOrTx, orderId: string) {
  await db.update(qrSessions).set({ revokedAt: new Date() }).where(and(eq(qrSessions.orderId, orderId), isNull(qrSessions.revokedAt)));
}

const ACTIVE = ['BOOKED', 'CONFIRMED', 'SEATED'] as const;

/**
 * Booking conflict rules (SPEC §3.3):
 *  - A specific table cannot hold two active reservations whose [start, start+duration) overlap,
 *    and must seat the party.
 *  - Without a table, there must be at least one table (in the requested zone) big enough for the
 *    party that is not already reserved in the overlapping window.
 */
export async function assertReservable(
  db: DbOrTx,
  p: { branchId: string; reservedAt: Date; durationMinutes: number; partySize: number; tableId?: string | null; zoneId?: string | null; excludeId?: string },
) {
  const start = p.reservedAt;
  const end = new Date(start.getTime() + p.durationMinutes * 60_000);
  const overlapping = await db
    .select({ id: reservations.id, tableId: reservations.tableId, partySize: reservations.partySize })
    .from(reservations)
    .where(
      and(
        eq(reservations.branchId, p.branchId),
        inArray(reservations.status, [...ACTIVE]),
        lt(reservations.reservedAt, end),
        sql`${reservations.reservedAt} + (${reservations.durationMinutes} * interval '1 minute') > ${start.toISOString()}::timestamptz`,
        p.excludeId ? ne(reservations.id, p.excludeId) : undefined,
      ),
    );
  const tables = await db
    .select()
    .from(diningTables)
    .where(and(eq(diningTables.branchId, p.branchId), isNull(diningTables.archivedAt), p.zoneId ? eq(diningTables.zoneId, p.zoneId) : undefined));
  if (p.tableId) {
    const t = tables.find((x) => x.id === p.tableId);
    if (!t) throw conflict('ไม่พบโต๊ะนี้ในโซนที่เลือก', 'RESERVATION_CONFLICT');
    if (t.capacity < p.partySize) throw conflict(`โต๊ะ ${t.name} รับได้ ${t.capacity} คน`, 'RESERVATION_CONFLICT');
    if (overlapping.some((r) => r.tableId === p.tableId)) throw conflict(`โต๊ะ ${t.name} ถูกจองในช่วงเวลานี้แล้ว`, 'RESERVATION_CONFLICT');
    return;
  }
  const reservedTables = new Set(overlapping.map((r) => r.tableId).filter(Boolean));
  const unassigned = overlapping.filter((r) => !r.tableId).length;
  const fitting = tables.filter((t) => t.capacity >= p.partySize && !reservedTables.has(t.id));
  // Unassigned overlapping bookings will each need some table too: keep capacity for them.
  if (fitting.length - unassigned <= 0) throw conflict('ไม่มีโต๊ะว่างที่รองรับจำนวนคนในช่วงเวลานี้', 'RESERVATION_CONFLICT');
}

/** Average real waiting time (created → seated) over the last 7 days; null until there are 5+ samples. */
export async function averageWaitMinutes(db: DbOrTx, branchId: string): Promise<number | null> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [r] = await db
    .select({ n: sql<number>`count(*)::int`, avg: sql<number>`coalesce(avg(extract(epoch from (${waitlistEntries.seatedAt} - ${waitlistEntries.createdAt})) / 60), 0)::float8` })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.branchId, branchId), eq(waitlistEntries.status, 'SEATED'), gt(waitlistEntries.createdAt, since)));
  return r.n >= 5 ? Math.round(r.avg) : null;
}
