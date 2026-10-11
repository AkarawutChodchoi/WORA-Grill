import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { orders } from '../../db/schema';
import { businessDate } from '../../lib/time';
import { branchSettings } from '../menu/service';
import { nextOrderNo } from './numbering';

export interface CreateOrderInput {
  id?: string;
  orgId: string;
  branchId: string;
  channel: string;
  source?: 'POS' | 'WAITER' | 'QR' | 'KIOSK' | 'DELIVERY_API';
  tableId?: string | null;
  guestCount?: number;
  openedBy?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  note?: string | null;
  externalRef?: string | null;
}

/**
 * Create a bill with a fresh running number and a snapshot of the branch's tax/service settings.
 * When `id` is supplied and already exists in this branch the existing order is returned (idempotent retry).
 */
export async function createOrder(db: DbOrTx, input: CreateOrderInput) {
  if (input.id) {
    const [existing] = await db.select().from(orders).where(eq(orders.id, input.id));
    if (existing) {
      if (existing.branchId !== input.branchId) throw new Error('order id collision');
      return { order: existing, created: false };
    }
  }
  const s = await branchSettings(db, input.branchId);
  const bd = businessDate(s.timezone);
  const orderNo = await nextOrderNo(db, input.branchId, bd);
  const [order] = await db
    .insert(orders)
    .values({
      id: input.id,
      organizationId: input.orgId,
      branchId: input.branchId,
      orderNo,
      businessDate: bd,
      channel: input.channel,
      source: input.source ?? 'POS',
      tableId: input.tableId ?? null,
      guestCount: input.guestCount ?? 1,
      openedBy: input.openedBy ?? null,
      customerName: input.customerName ?? null,
      customerPhone: input.customerPhone ?? null,
      note: input.note ?? null,
      externalRef: input.externalRef ?? null,
      pricing: {
        vatMode: s.vatMode,
        vatBps: s.vatBps,
        serviceChargeBps: s.serviceChargeChannels.includes(input.channel) ? s.serviceChargeBps : 0,
        serviceChargeTaxable: s.serviceChargeTaxable,
      },
    })
    .returning();
  return { order, created: true };
}
