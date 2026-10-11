import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { orderCounters } from '../../db/schema';

/**
 * Next bill number for a branch's business day, e.g. "0001". Atomic under concurrency thanks to
 * INSERT … ON CONFLICT DO UPDATE … RETURNING (row lock on the counter).
 */
export async function nextOrderNo(db: DbOrTx, branchId: string, businessDate: string): Promise<string> {
  const [row] = await db
    .insert(orderCounters)
    .values({ branchId, businessDate, lastNo: 1 })
    .onConflictDoUpdate({ target: [orderCounters.branchId, orderCounters.businessDate], set: { lastNo: sql`${orderCounters.lastNo} + 1` } })
    .returning({ lastNo: orderCounters.lastNo });
  return String(row.lastNo).padStart(4, '0');
}
