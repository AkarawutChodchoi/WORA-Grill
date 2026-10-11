import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { TableStatus } from '@shared/states';
import type { DbOrTx } from '../../db/client';
import { diningTables, orders } from '../../db/schema';
import type { EventBus } from '../../lib/events';
import { conflict, notFound } from '../../lib/errors';

export async function loadTableForUpdate(db: DbOrTx, orgId: string, branchId: string, tableId: string) {
  const [t] = await db
    .select()
    .from(diningTables)
    .where(and(eq(diningTables.id, tableId), eq(diningTables.organizationId, orgId), eq(diningTables.branchId, branchId), isNull(diningTables.archivedAt)))
    .for('update');
  if (!t) throw notFound('โต๊ะ');
  return t;
}

/**
 * Derive a table's status from its active order and item states (SPEC §3.2):
 * OCCUPIED (seated, nothing sent) → WAITING_FOOD (items in kitchen) → DINING (all served) → BILL_REQUESTED.
 * Without an active order a table is AVAILABLE unless staff marked it CLEANING.
 */
export async function deriveTableStatus(db: DbOrTx, orderId: string | null, current: TableStatus): Promise<TableStatus> {
  if (!orderId) return current === 'CLEANING' ? 'CLEANING' : 'AVAILABLE';
  const [o] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!o || !['OPEN', 'BILL_REQUESTED'].includes(o.status)) return 'CLEANING';
  if (o.status === 'BILL_REQUESTED') return 'BILL_REQUESTED';
  const r = await db.execute<{ in_kitchen: number; served: number }>(
    sql`select count(*) filter (where status in ('SENT','PREPARING','READY'))::int as in_kitchen,
               count(*) filter (where status = 'SERVED')::int as served
        from order_items where order_id = ${orderId}`,
  );
  const row = (r as any).rows?.[0] ?? { in_kitchen: 0, served: 0 };
  if (row.in_kitchen > 0) return 'WAITING_FOOD';
  if (row.served > 0) return 'DINING';
  return 'OCCUPIED';
}

/** Recompute and persist the status of the table(s) attached to an order; publishes table.status_changed. */
export async function refreshTableForOrder(db: DbOrTx, bus: EventBus | null, orderId: string) {
  const ts = await db.select().from(diningTables).where(eq(diningTables.currentOrderId, orderId));
  for (const t of ts) await setDerivedStatus(db, bus, t);
}

export async function setDerivedStatus(db: DbOrTx, bus: EventBus | null, t: typeof diningTables.$inferSelect) {
  const next = await deriveTableStatus(db, t.currentOrderId, t.status);
  if (next === t.status) return t.status;
  await db
    .update(diningTables)
    .set({ status: next, statusChangedAt: new Date(), version: sql`${diningTables.version} + 1` })
    .where(inArray(diningTables.id, [t.id, ...(await joinedTableIds(db, t.id))]));
  bus?.publish({ type: 'table.status_changed', organizationId: t.organizationId, branchId: t.branchId, payload: { tableId: t.id, status: next } });
  return next;
}

async function joinedTableIds(db: DbOrTx, primaryId: string): Promise<string[]> {
  const rows = await db.select({ id: diningTables.id }).from(diningTables).where(eq(diningTables.mergedIntoTableId, primaryId));
  return rows.map((r) => r.id);
}

/**
 * Release a table when its order is paid/closed/voided/moved: it becomes CLEANING (or AVAILABLE when
 * nothing was served, e.g. a void right after opening) and joined tables are released too.
 */
export async function releaseTable(db: DbOrTx, bus: EventBus | null, tableId: string, toStatus: 'CLEANING' | 'AVAILABLE' = 'CLEANING') {
  const [t] = await db.select().from(diningTables).where(eq(diningTables.id, tableId));
  if (!t) return;
  const ids = [t.id, ...(await joinedTableIds(db, t.id))];
  await db
    .update(diningTables)
    .set({ currentOrderId: null, mergedIntoTableId: null, status: toStatus, statusChangedAt: new Date(), version: sql`${diningTables.version} + 1` })
    .where(inArray(diningTables.id, ids));
  for (const id of ids) bus?.publish({ type: 'table.status_changed', organizationId: t.organizationId, branchId: t.branchId, payload: { tableId: id, status: toStatus } });
}

export function assertFree(t: typeof diningTables.$inferSelect) {
  if (t.currentOrderId || t.mergedIntoTableId) throw conflict(`โต๊ะ ${t.name} มีลูกค้าอยู่แล้ว`, 'TABLE_OCCUPIED');
  if (t.status === 'CLEANING') throw conflict(`โต๊ะ ${t.name} ยังรอทำความสะอาด`, 'TABLE_CLEANING');
}
