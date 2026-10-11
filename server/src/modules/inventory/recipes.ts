import Decimal from 'decimal.js';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { comboComponents, recipeLines, recipes, stockBalances, stockMovements } from '../../db/schema';
import { orderHooks } from '../orders/hooks';
import type { Order, OrderItem } from '../orders/service';
import { D, defaultWarehouse, postMovement } from './ledger';

export type Usage = Map<string, Decimal>;

function add(u: Usage, ingredientId: string, q: Decimal) {
  u.set(ingredientId, (u.get(ingredientId) ?? D(0)).plus(q));
}

/** Base-unit ingredient usage of a set of recipes keyed by menu item / modifier. */
async function loadRecipes(db: DbOrTx, menuItemIds: string[], modifierIds: string[]) {
  if (!menuItemIds.length && !modifierIds.length) return [];
  const rs = await db
    .select()
    .from(recipes)
    .where(or(menuItemIds.length ? inArray(recipes.menuItemId, menuItemIds) : undefined, modifierIds.length ? inArray(recipes.modifierId, modifierIds) : undefined));
  if (!rs.length) return [];
  const lines = await db.select().from(recipeLines).where(inArray(recipeLines.recipeId, rs.map((r) => r.id)));
  return rs.map((r) => ({ ...r, lines: lines.filter((l) => l.recipeId === r.id) }));
}

/**
 * Theoretical ingredient usage for one order line: item recipe (or combo components' recipes when the
 * combo has none) + modifier recipes, all × line quantity.
 */
export async function usageForItem(db: DbOrTx, item: Pick<OrderItem, 'menuItemId' | 'qty' | 'modifiers'>): Promise<Usage> {
  const usage: Usage = new Map();
  const modIds = item.modifiers.map((m) => m.modifierId);
  let rs = await loadRecipes(db, [item.menuItemId], modIds);
  const own = rs.find((r) => r.menuItemId === item.menuItemId);
  if (own) for (const l of own.lines) add(usage, l.ingredientId, D(l.qtyBase).mul(item.qty));
  else {
    const comps = await db.select().from(comboComponents).where(eq(comboComponents.comboItemId, item.menuItemId));
    if (comps.length) {
      rs = [...rs, ...(await loadRecipes(db, comps.map((c) => c.componentItemId), []))];
      for (const c of comps) {
        const r = rs.find((x) => x.menuItemId === c.componentItemId);
        if (r) for (const l of r.lines) add(usage, l.ingredientId, D(l.qtyBase).mul(c.qty).mul(item.qty));
      }
    }
  }
  for (const m of item.modifiers) {
    const r = rs.find((x) => x.modifierId === m.modifierId);
    if (r) for (const l of r.lines) add(usage, l.ingredientId, D(l.qtyBase).mul(m.qty).mul(item.qty));
  }
  return usage;
}

/** Plate cost of a menu item from its recipe at current average costs (satang). */
export async function recipeCost(db: DbOrTx, warehouseId: string, menuItemId: string): Promise<{ cost: Decimal; hasRecipe: boolean }> {
  const usage = await usageForItem(db, { menuItemId, qty: 1, modifiers: [] });
  if (usage.size === 0) return { cost: D(0), hasRecipe: false };
  const bals = await db
    .select()
    .from(stockBalances)
    .where(and(eq(stockBalances.warehouseId, warehouseId), inArray(stockBalances.ingredientId, [...usage.keys()])));
  let cost = D(0);
  for (const [ing, q] of usage) cost = cost.plus(q.mul(bals.find((b) => b.ingredientId === ing)?.avgCost ?? 0));
  return { cost, hasRecipe: true };
}

/**
 * Stock deduction business event: items are deducted when SENT to the kitchen (assumption documented in
 * docs/10-inventory.md) and reversed if a sent item is cancelled. Idempotency keys make retries safe.
 */
let registered = false;
export function registerInventoryHooks() {
  if (registered) return;
  registered = true;
  orderHooks.itemsSent.push(async (ctx, order: Order, items: OrderItem[]) => {
    const wh = await defaultWarehouse(ctx.db, order.organizationId, order.branchId);
    for (const it of items) {
      const usage = await usageForItem(ctx.db, it);
      for (const [ingredientId, q] of usage) {
        const posted = await postMovement(ctx.db, {
          orgId: order.organizationId,
          branchId: order.branchId,
          warehouseId: wh,
          ingredientId,
          type: 'SALE',
          qty: q.neg(),
          refType: 'order_item',
          refId: it.id,
          reason: `บิล #${order.orderNo} ${it.nameSnapshot}`,
          idempotencyKey: `SALE:${it.id}:${ingredientId}`,
          createdBy: ctx.actor.userId,
          allowNegative: true,
        });
        if (posted?.crossedReorderPoint || posted?.wentNegative)
          ctx.bus?.publish({ type: 'stock.low', organizationId: order.organizationId, branchId: order.branchId, payload: { ingredientId, balance: posted.balanceAfter.toString(), negative: posted.wentNegative } });
      }
    }
  });

  orderHooks.itemsCancelled.push(async (ctx, order: Order, items: OrderItem[]) => {
    const sales = await ctx.db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.refType, 'order_item'), inArray(stockMovements.refId, items.map((i) => i.id)), eq(stockMovements.type, 'SALE'), isNotNull(stockMovements.idempotencyKey)));
    for (const s of sales) {
      await postMovement(ctx.db, {
        orgId: s.organizationId,
        branchId: s.branchId,
        warehouseId: s.warehouseId,
        ingredientId: s.ingredientId,
        type: 'SALE_REVERSAL',
        qty: D(s.qty).neg(),
        unitCost: D(s.unitCost),
        refType: 'order_item',
        refId: s.refId!,
        reason: `ยกเลิกรายการ บิล #${order.orderNo}`,
        idempotencyKey: `SALE_REV:${s.refId}:${s.ingredientId}`,
        createdBy: ctx.actor.userId,
        allowNegative: true,
      });
    }
  });
}
