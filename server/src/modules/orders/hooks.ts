import type { DbOrTx } from '../../db/client';
import type { AuthContext } from '../../lib/auth';
import type { EventBus } from '../../lib/events';
import type { Order, OrderItem } from './service';

/**
 * Extension points other modules attach to (inventory deduction, loyalty, promotions…). Hooks run
 * inside the same DB transaction as the order change, so a failure rolls everything back.
 */
export interface HookCtx {
  db: DbOrTx;
  actor: Pick<AuthContext, 'orgId' | 'branchId' | 'userId'>;
  bus?: EventBus | null;
}

type ItemsHook = (ctx: HookCtx, order: Order, items: OrderItem[]) => Promise<void>;
type OrderHook = (ctx: HookCtx, order: Order) => Promise<void>;
type DiscountHook = (ctx: HookCtx, discountId: string) => Promise<void>;
type RefundHook = (ctx: HookCtx, payment: { id: string; orderId: string; method: string }, amountSatang: number) => Promise<void>;

export const orderHooks = {
  itemsSent: [] as ItemsHook[],
  itemsCancelled: [] as ItemsHook[],
  orderPaid: [] as OrderHook[],
  orderVoided: [] as OrderHook[],
  orderReopened: [] as OrderHook[],
  /**
   * Runs in its own committed transaction before money is taken (e.g. re-check promotions).
   * Returns human-readable changes; any change aborts the payment so the cashier can re-check the total.
   */
  beforePayment: [] as ((ctx: HookCtx, order: Order) => Promise<string[]>)[],
  discountRemoved: [] as DiscountHook[],
  paymentRefunded: [] as RefundHook[],
};

export async function runItemsHook(list: ItemsHook[], ctx: HookCtx, order: Order, items: OrderItem[]) {
  if (items.length === 0) return;
  for (const h of list) await h(ctx, order, items);
}

export async function runOrderHook(list: OrderHook[], ctx: HookCtx, order: Order) {
  for (const h of list) await h(ctx, order);
}
