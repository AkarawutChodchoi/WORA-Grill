import Decimal from 'decimal.js';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { ingredients, ingredientUnits, stockBalances, stockLots, stockMovements, warehouses } from '../../db/schema';
import { STOCK_MOVEMENT_TYPES } from '../../db/schema/inventory';
import { badRequest, unprocessable } from '../../lib/errors';

export type MovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export const D = (v: Decimal.Value) => new Decimal(v);

/** The branch's default warehouse, created on first use. */
export async function defaultWarehouse(db: DbOrTx, orgId: string, branchId: string): Promise<string> {
  const [w] = await db.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.branchId, branchId), eq(warehouses.isDefault, true)));
  if (w) return w.id;
  const [created] = await db
    .insert(warehouses)
    .values({ organizationId: orgId, branchId, name: 'คลังหลัก', isDefault: true })
    .onConflictDoNothing()
    .returning({ id: warehouses.id });
  if (created) return created.id;
  const [again] = await db.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.branchId, branchId), eq(warehouses.isDefault, true)));
  return again.id;
}

/** Convert a quantity in `unit` to the ingredient's base unit using its explicit conversions. */
export async function toBase(db: DbOrTx, ingredientId: string, qty: Decimal.Value, unit: string): Promise<Decimal> {
  const [ing] = await db.select({ baseUnit: ingredients.baseUnit }).from(ingredients).where(eq(ingredients.id, ingredientId));
  if (!ing) throw badRequest('ไม่พบวัตถุดิบ');
  if (unit === ing.baseUnit) return D(qty);
  const [u] = await db.select().from(ingredientUnits).where(and(eq(ingredientUnits.ingredientId, ingredientId), eq(ingredientUnits.unit, unit)));
  if (!u) throw badRequest(`ไม่มีการตั้งค่าแปลงหน่วย "${unit}" สำหรับวัตถุดิบนี้`);
  return D(qty).mul(u.factor);
}

export interface PostMovementInput {
  orgId: string;
  branchId: string;
  warehouseId: string;
  ingredientId: string;
  type: MovementType;
  /** Signed quantity in base units. */
  qty: Decimal;
  /** Satang per base unit for inbound movements; outbound always use the current average. */
  unitCost?: Decimal | null;
  refType?: string;
  refId?: string;
  reason?: string | null;
  idempotencyKey?: string;
  createdBy?: string | null;
  approvedBy?: string | null;
  lot?: { lotNo?: string | null; expiryDate?: string | null };
  /** Allow going below zero (sales must never block the kitchen — assumption A7). */
  allowNegative?: boolean;
}

export interface PostedMovement {
  id: string;
  ingredientId: string;
  qty: Decimal;
  unitCost: Decimal;
  balanceAfter: Decimal;
  crossedReorderPoint: boolean;
  wentNegative: boolean;
}

/**
 * Append one movement to the stock ledger and update the cached balance + weighted-average cost
 * in the same transaction. Idempotent when an idempotencyKey is given (returns null on replay).
 */
export async function postMovement(db: DbOrTx, m: PostMovementInput): Promise<PostedMovement | null> {
  if (m.qty.isZero()) return null;
  if (m.idempotencyKey) {
    const [dup] = await db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.idempotencyKey, m.idempotencyKey));
    if (dup) return null;
  }
  const [ing] = await db.select().from(ingredients).where(and(eq(ingredients.id, m.ingredientId), eq(ingredients.organizationId, m.orgId)));
  if (!ing) throw badRequest('ไม่พบวัตถุดิบ');
  await db.insert(stockBalances).values({ warehouseId: m.warehouseId, ingredientId: m.ingredientId }).onConflictDoNothing();
  const [bal] = await db
    .select()
    .from(stockBalances)
    .where(and(eq(stockBalances.warehouseId, m.warehouseId), eq(stockBalances.ingredientId, m.ingredientId)))
    .for('update');
  const oldQty = D(bal.qty);
  const oldAvg = D(bal.avgCost);
  const newQty = oldQty.plus(m.qty);
  let unitCost = oldAvg;
  let newAvg = oldAvg;
  if (m.qty.isPositive()) {
    unitCost = m.unitCost ?? oldAvg;
    if (unitCost.isNegative()) throw badRequest('ต้นทุนติดลบไม่ได้');
    newAvg = oldQty.lte(0) ? unitCost : oldQty.mul(oldAvg).plus(m.qty.mul(unitCost)).div(newQty);
  } else if (newQty.isNegative() && !m.allowNegative) {
    throw unprocessable(`สต็อก "${ing.name}" ไม่พอ (คงเหลือ ${oldQty.toFixed(2)} ${ing.baseUnit})`, 'INSUFFICIENT_STOCK', { ingredientId: ing.id, onHand: oldQty.toString() });
  }

  let lotId: string | null = null;
  if (ing.trackExpiry && m.qty.isPositive()) {
    const [lot] = await db
      .insert(stockLots)
      .values({ warehouseId: m.warehouseId, ingredientId: m.ingredientId, lotNo: m.lot?.lotNo ?? null, expiryDate: m.lot?.expiryDate ?? null, receivedQty: m.qty.toFixed(4), remainingQty: m.qty.toFixed(4) })
      .returning({ id: stockLots.id });
    lotId = lot.id;
  } else if (ing.trackExpiry && m.qty.isNegative()) {
    // FEFO: consume lots with the earliest expiry first.
    let need = m.qty.neg();
    const lots = await db
      .select()
      .from(stockLots)
      .where(and(eq(stockLots.warehouseId, m.warehouseId), eq(stockLots.ingredientId, m.ingredientId), gt(stockLots.remainingQty, '0')))
      .orderBy(sql`${stockLots.expiryDate} asc nulls last`, asc(stockLots.receivedAt))
      .for('update');
    for (const l of lots) {
      if (need.lte(0)) break;
      const take = Decimal.min(need, l.remainingQty);
      await db.update(stockLots).set({ remainingQty: D(l.remainingQty).minus(take).toFixed(4) }).where(eq(stockLots.id, l.id));
      lotId ??= l.id;
      need = need.minus(take);
    }
  }

  const [row] = await db
    .insert(stockMovements)
    .values({
      organizationId: m.orgId,
      branchId: m.branchId,
      warehouseId: m.warehouseId,
      ingredientId: m.ingredientId,
      type: m.type,
      qty: m.qty.toFixed(4),
      unitCost: unitCost.toFixed(6),
      value: m.qty.mul(unitCost).toFixed(2),
      balanceAfter: newQty.toFixed(4),
      lotId,
      refType: m.refType,
      refId: m.refId,
      reason: m.reason ?? null,
      idempotencyKey: m.idempotencyKey,
      createdBy: m.createdBy ?? null,
      approvedBy: m.approvedBy ?? null,
    })
    .returning({ id: stockMovements.id });
  await db
    .update(stockBalances)
    .set({ qty: newQty.toFixed(4), avgCost: newAvg.toFixed(6) })
    .where(and(eq(stockBalances.warehouseId, m.warehouseId), eq(stockBalances.ingredientId, m.ingredientId)));
  const rp = D(ing.reorderPoint);
  return {
    id: row.id,
    ingredientId: m.ingredientId,
    qty: m.qty,
    unitCost,
    balanceAfter: newQty,
    crossedReorderPoint: rp.gt(0) && oldQty.gt(rp) && newQty.lte(rp),
    wentNegative: newQty.isNegative() && !oldQty.isNegative(),
  };
}

/** Rebuild the balance cache from the ledger and report any drift (cache vs ledger). */
export async function reconcile(db: DbOrTx, warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [];
  const ledger = await db
    .select({ warehouseId: stockMovements.warehouseId, ingredientId: stockMovements.ingredientId, qty: sql<string>`sum(${stockMovements.qty})` })
    .from(stockMovements)
    .where(inArray(stockMovements.warehouseId, warehouseIds))
    .groupBy(stockMovements.warehouseId, stockMovements.ingredientId);
  const cache = await db.select().from(stockBalances).where(inArray(stockBalances.warehouseId, warehouseIds));
  const drift: { warehouseId: string; ingredientId: string; cached: string; ledger: string }[] = [];
  for (const l of ledger) {
    const c = cache.find((x) => x.warehouseId === l.warehouseId && x.ingredientId === l.ingredientId);
    if (!c || !D(c.qty).eq(l.qty)) {
      drift.push({ warehouseId: l.warehouseId, ingredientId: l.ingredientId, cached: c?.qty ?? '0', ledger: D(l.qty).toFixed(4) });
      if (c) await db.update(stockBalances).set({ qty: D(l.qty).toFixed(4) }).where(and(eq(stockBalances.warehouseId, l.warehouseId), eq(stockBalances.ingredientId, l.ingredientId)));
      else await db.insert(stockBalances).values({ warehouseId: l.warehouseId, ingredientId: l.ingredientId, qty: D(l.qty).toFixed(4) });
    }
  }
  return drift;
}

export async function activeIngredientIds(db: DbOrTx, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  return (await db.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.organizationId, orgId), inArray(ingredients.id, ids), isNull(ingredients.archivedAt)))).map((r) => r.id);
}
