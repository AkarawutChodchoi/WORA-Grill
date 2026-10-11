import Decimal from 'decimal.js';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvalSchema, dateString, decimalString, nonEmpty, reasonSchema, uuid } from '@shared/validation';
import type { DbOrTx } from '../../db/client';
import {
  ingredients,
  ingredientUnits,
  menuItems,
  recipeLines,
  recipes,
  stockBalances,
  stockCountLines,
  stockCounts,
  stockLots,
  stockMovements,
  users,
  warehouses,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeSensitive, requireAnyPerm, requireBranch, requirePerm, type AuthContext } from '../../lib/auth';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../../lib/errors';
import { localRange } from '../../lib/time';
import { branchSettings } from '../menu/service';
import { D, defaultWarehouse, postMovement, reconcile, toBase, type PostedMovement } from './ledger';
import { recipeCost, registerInventoryHooks } from './recipes';

registerInventoryHooks();

const unitName = z.string().trim().min(1).max(20);
const positive = decimalString.refine((v) => new Decimal(v).gt(0), 'ต้องมากกว่า 0');
const nonNegative = decimalString.refine((v) => new Decimal(v).gte(0), 'ต้องไม่ติดลบ');

const ingredientBody = z.object({
  name: nonEmpty(100),
  sku: z.string().trim().max(40).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  baseUnit: unitName,
  reorderPoint: nonNegative.default('0'),
  reorderQty: nonNegative.default('0'),
  isSubRecipe: z.boolean().default(false),
  trackExpiry: z.boolean().default(false),
  units: z.array(z.object({ unit: unitName, factor: positive, isPurchase: z.boolean().default(false), isUsage: z.boolean().default(false) })).max(10).default([]),
});

const lineSchema = z.object({ ingredientId: uuid, qty: positive, unit: unitName });

async function ownIngredient(db: DbOrTx, orgId: string, id: string) {
  const [i] = await db.select().from(ingredients).where(and(eq(ingredients.id, id), eq(ingredients.organizationId, orgId)));
  if (!i) throw notFound('วัตถุดิบ');
  return i;
}

async function warehouseFor(db: DbOrTx, a: AuthContext, warehouseId?: string) {
  const branchId = requireBranch(a);
  if (!warehouseId) return defaultWarehouse(db, a.orgId, branchId);
  const [w] = await db.select().from(warehouses).where(and(eq(warehouses.id, warehouseId), eq(warehouses.branchId, branchId)));
  if (!w) throw notFound('คลัง');
  return w.id;
}

export default async function inventoryRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;
  const lowStock = (a: AuthContext, posted: (PostedMovement | null)[]) => {
    for (const p of posted)
      if (p && (p.crossedReorderPoint || p.wentNegative))
        bus.publish({ type: 'stock.low', organizationId: a.orgId, branchId: a.branchId, payload: { ingredientId: p.ingredientId, balance: p.balanceAfter.toString() } });
  };

  // ---------- Warehouses ----------
  app.get('/inventory/warehouses', async (req) => {
    const a = requireAnyPerm(req, 'inventory.view', 'stock.receive');
    const branchId = requireBranch(a);
    await defaultWarehouse(db, a.orgId, branchId);
    return { warehouses: await db.select().from(warehouses).where(and(eq(warehouses.branchId, branchId), isNull(warehouses.archivedAt))).orderBy(desc(warehouses.isDefault), asc(warehouses.name)) };
  });
  app.post('/inventory/warehouses', async (req) => {
    const a = requirePerm(req, 'inventory.manage');
    const branchId = requireBranch(a);
    const { name } = parse(z.object({ name: nonEmpty(60) }), req.body);
    const [w] = await db.insert(warehouses).values({ organizationId: a.orgId, branchId, name }).returning();
    await audit(db, a, { action: 'warehouse.create', targetType: 'warehouse', targetId: w.id, data: { name } }, req.ip);
    return w;
  });

  // ---------- Ingredients ----------
  app.get('/inventory/ingredients', async (req) => {
    const a = requireAnyPerm(req, 'inventory.view', 'stock.receive', 'stock.count');
    const q = parse(z.object({ warehouseId: uuid.optional(), archived: z.coerce.boolean().default(false) }), req.query);
    const wh = await warehouseFor(db, a, q.warehouseId);
    const list = await db
      .select({ ing: ingredients, qty: stockBalances.qty, avgCost: stockBalances.avgCost })
      .from(ingredients)
      .leftJoin(stockBalances, and(eq(stockBalances.ingredientId, ingredients.id), eq(stockBalances.warehouseId, wh)))
      .where(and(eq(ingredients.organizationId, a.orgId), q.archived ? undefined : isNull(ingredients.archivedAt)))
      .orderBy(asc(ingredients.category), asc(ingredients.name));
    const units = list.length ? await db.select().from(ingredientUnits).where(inArray(ingredientUnits.ingredientId, list.map((l) => l.ing.id))) : [];
    const showCost = a.permissions.has('report.view_profit') || a.permissions.has('inventory.manage');
    return {
      warehouseId: wh,
      ingredients: list.map((l) => {
        const onHand = D(l.qty ?? 0);
        return {
          ...l.ing,
          onHand: onHand.toFixed(4),
          avgCost: showCost ? D(l.avgCost ?? 0).toFixed(6) : null,
          stockValue: showCost ? onHand.mul(l.avgCost ?? 0).toFixed(2) : null,
          low: D(l.ing.reorderPoint).gt(0) && onHand.lte(l.ing.reorderPoint),
          units: units.filter((u) => u.ingredientId === l.ing.id),
        };
      }),
    };
  });

  app.post('/inventory/ingredients', async (req) => {
    const a = requirePerm(req, 'inventory.manage');
    const body = parse(ingredientBody, req.body);
    try {
      const ing = await db.transaction(async (tx) => {
        const { units, ...cols } = body;
        const [i] = await tx.insert(ingredients).values({ organizationId: a.orgId, ...cols }).returning();
        const us = units.filter((u) => u.unit !== body.baseUnit);
        if (us.length) await tx.insert(ingredientUnits).values(us.map((u) => ({ ingredientId: i.id, ...u })));
        await audit(tx, a, { action: 'ingredient.create', targetType: 'ingredient', targetId: i.id, data: body, branchId: null }, req.ip);
        return i;
      });
      return ing;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('มีวัตถุดิบชื่อนี้แล้ว');
      throw e;
    }
  });

  app.put('/inventory/ingredients/:id', async (req) => {
    const a = requirePerm(req, 'inventory.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(ingredientBody.extend({ archived: z.boolean().optional() }), req.body);
    const before = await ownIngredient(db, a.orgId, id);
    if (body.baseUnit !== before.baseUnit) {
      const [m] = await db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.ingredientId, id)).limit(1);
      if (m) throw conflict('มีการเคลื่อนไหวสต็อกแล้ว เปลี่ยนหน่วยหลักไม่ได้ (สร้างวัตถุดิบใหม่แทน)');
    }
    try {
      await db.transaction(async (tx) => {
        const { units, archived, ...cols } = body;
        await tx
          .update(ingredients)
          .set({ ...cols, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
          .where(eq(ingredients.id, id));
        await tx.delete(ingredientUnits).where(eq(ingredientUnits.ingredientId, id));
        const us = units.filter((u) => u.unit !== body.baseUnit);
        if (us.length) await tx.insert(ingredientUnits).values(us.map((u) => ({ ingredientId: id, ...u })));
        await audit(tx, a, { action: 'ingredient.update', targetType: 'ingredient', targetId: id, data: body, branchId: null }, req.ip);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('มีวัตถุดิบชื่อนี้แล้ว');
      throw e;
    }
    return { ok: true };
  });

  // ---------- Recipes ----------
  app.get('/inventory/recipes', async (req) => {
    const a = requireAnyPerm(req, 'inventory.view', 'menu.manage');
    const rs = await db.select().from(recipes).where(eq(recipes.organizationId, a.orgId));
    const lines = rs.length ? await db.select().from(recipeLines).where(inArray(recipeLines.recipeId, rs.map((r) => r.id))) : [];
    return { recipes: rs.map((r) => ({ ...r, lines: lines.filter((l) => l.recipeId === r.id) })) };
  });

  /** Create or replace the recipe of a menu item, a modifier, or a sub-recipe ingredient. */
  app.put('/inventory/recipes', async (req) => {
    const a = requirePerm(req, 'inventory.manage');
    const body = parse(
      z
        .object({
          menuItemId: uuid.optional(),
          modifierId: uuid.optional(),
          outputIngredientId: uuid.optional(),
          yieldQty: positive.default('1'),
          note: z.string().max(500).optional(),
          lines: z.array(lineSchema).max(60),
        })
        .refine((b) => [b.menuItemId, b.modifierId, b.outputIngredientId].filter(Boolean).length === 1, 'ระบุเป้าหมายของสูตรอย่างใดอย่างหนึ่ง'),
      req.body,
    );
    if (body.menuItemId) {
      const [m] = await db.select({ id: menuItems.id }).from(menuItems).where(and(eq(menuItems.id, body.menuItemId), eq(menuItems.organizationId, a.orgId)));
      if (!m) throw notFound('เมนู');
    }
    if (body.modifierId) {
      const [m] = await db.execute<{ id: string }>(sql`select m.id from modifiers m join modifier_groups g on g.id = m.group_id where m.id = ${body.modifierId} and g.organization_id = ${a.orgId}`).then((r: any) => r.rows);
      if (!m) throw notFound('ตัวเลือก');
    }
    if (body.outputIngredientId) {
      const out = await ownIngredient(db, a.orgId, body.outputIngredientId);
      if (!out.isSubRecipe) throw badRequest('วัตถุดิบปลายทางต้องตั้งเป็นวัตถุดิบกึ่งสำเร็จ');
      if (body.lines.some((l) => l.ingredientId === out.id)) throw badRequest('สูตรใช้ตัวเองเป็นส่วนผสมไม่ได้');
    }
    const resolved: { ingredientId: string; qty: string; unit: string; qtyBase: string }[] = [];
    for (const l of body.lines) {
      await ownIngredient(db, a.orgId, l.ingredientId);
      resolved.push({ ...l, qtyBase: (await toBase(db, l.ingredientId, l.qty, l.unit)).toFixed(4) });
    }
    const id = await db.transaction(async (tx) => {
      const where = body.menuItemId ? eq(recipes.menuItemId, body.menuItemId) : body.modifierId ? eq(recipes.modifierId, body.modifierId) : eq(recipes.outputIngredientId, body.outputIngredientId!);
      let [r] = await tx.select().from(recipes).where(and(where, eq(recipes.organizationId, a.orgId)));
      if (r) await tx.update(recipes).set({ yieldQty: body.yieldQty, note: body.note ?? null }).where(eq(recipes.id, r.id));
      else
        [r] = await tx
          .insert(recipes)
          .values({ organizationId: a.orgId, menuItemId: body.menuItemId ?? null, modifierId: body.modifierId ?? null, outputIngredientId: body.outputIngredientId ?? null, yieldQty: body.yieldQty, note: body.note ?? null })
          .returning();
      await tx.delete(recipeLines).where(eq(recipeLines.recipeId, r.id));
      if (resolved.length) await tx.insert(recipeLines).values(resolved.map((l) => ({ recipeId: r.id, ingredientId: l.ingredientId, qty: l.qty, unit: l.unit, qtyBase: l.qtyBase })));
      await audit(tx, a, { action: 'recipe.save', targetType: 'recipe', targetId: r.id, data: body, branchId: null }, req.ip);
      return r.id;
    });
    return { id };
  });

  /** Plate cost and food-cost % per menu item at current average costs (needs profit visibility). */
  app.get('/inventory/menu-costs', async (req) => {
    const a = requirePerm(req, 'report.view_profit');
    const wh = await warehouseFor(db, a);
    const items = await db.select().from(menuItems).where(and(eq(menuItems.organizationId, a.orgId), isNull(menuItems.archivedAt))).orderBy(asc(menuItems.name));
    const out = [];
    for (const i of items) {
      const { cost, hasRecipe } = await recipeCost(db, wh, i.id);
      out.push({
        menuItemId: i.id,
        name: i.name,
        priceSatang: i.priceSatang,
        hasRecipe,
        costSatang: Number(cost.toFixed(0)),
        foodCostPct: hasRecipe && i.priceSatang > 0 ? Number(cost.div(i.priceSatang).mul(100).toFixed(1)) : null,
      });
    }
    return { items: out, method: 'WEIGHTED_AVERAGE' };
  });

  // ---------- Stock operations (each creates ledger movements) ----------
  const opBody = z.object({ warehouseId: uuid.optional(), note: z.string().trim().max(300).optional() });

  /** Receive stock without a PO (direct purchase / market run). PO receiving is in purchasing. */
  app.post('/inventory/receive', async (req) => {
    const a = requirePerm(req, 'stock.receive');
    const body = parse(
      opBody.extend({
        lines: z
          .array(lineSchema.extend({ unitCostSatang: z.number().int().min(0).max(100_000_000), lotNo: z.string().max(40).optional(), expiryDate: dateString.optional() }))
          .min(1)
          .max(100),
      }),
      req.body,
    );
    const wh = await warehouseFor(db, a, body.warehouseId);
    const ref = crypto.randomUUID();
    await db.transaction(async (tx) => {
      for (const l of body.lines) {
        await ownIngredient(tx, a.orgId, l.ingredientId);
        const base = await toBase(tx, l.ingredientId, l.qty, l.unit);
        // Cost is entered per purchase unit; convert to satang per base unit.
        const perBase = D(l.unitCostSatang).mul(l.qty).div(base);
        await postMovement(tx, { orgId: a.orgId, branchId: a.branchId!, warehouseId: wh, ingredientId: l.ingredientId, type: 'PURCHASE', qty: base, unitCost: perBase, refType: 'receive', refId: ref, reason: body.note, createdBy: a.userId, lot: { lotNo: l.lotNo, expiryDate: l.expiryDate } });
      }
      await audit(tx, a, { action: 'stock.receive', targetType: 'stock_receive', targetId: ref, data: body }, req.ip);
    });
    return { ref };
  });

  /** Issue (withdraw for use), waste (with reason) — outbound movements valued at average cost. */
  for (const kind of ['issue', 'waste'] as const) {
    app.post(`/inventory/${kind}`, async (req) => {
      const a = requirePerm(req, kind === 'issue' ? 'stock.issue' : 'stock.waste');
      const body = parse(opBody.extend({ reason: reasonSchema, lines: z.array(lineSchema.extend({ reason: z.string().max(200).optional() })).min(1).max(100) }), req.body);
      const wh = await warehouseFor(db, a, body.warehouseId);
      const ref = crypto.randomUUID();
      const posted = await db.transaction(async (tx) => {
        const out = [];
        for (const l of body.lines) {
          await ownIngredient(tx, a.orgId, l.ingredientId);
          const base = await toBase(tx, l.ingredientId, l.qty, l.unit);
          out.push(
            await postMovement(tx, { orgId: a.orgId, branchId: a.branchId!, warehouseId: wh, ingredientId: l.ingredientId, type: kind === 'issue' ? 'ISSUE' : 'WASTE', qty: base.neg(), refType: kind, refId: ref, reason: l.reason || body.reason, createdBy: a.userId }),
          );
        }
        await audit(tx, a, { action: `stock.${kind}`, targetType: `stock_${kind}`, targetId: ref, reason: body.reason, data: { lines: body.lines } }, req.ip);
        return out;
      });
      lowStock(a, posted);
      return { ref };
    });
  }

  /** Manual adjustment to a new on-hand quantity (requires stock.adjust or manager PIN). */
  app.post('/inventory/adjust', async (req) => {
    const a = requirePerm(req, 'inventory.view');
    const body = parse(opBody.extend({ reason: reasonSchema, approval: approvalSchema, lines: z.array(z.object({ ingredientId: uuid, newQty: nonNegative })).min(1).max(100) }), req.body);
    const wh = await warehouseFor(db, a, body.warehouseId);
    const ref = crypto.randomUUID();
    await db.transaction(async (tx) => {
      const approver = await authorizeSensitive(tx, a, 'stock.adjust', body.approval);
      for (const l of body.lines) {
        await ownIngredient(tx, a.orgId, l.ingredientId);
        const [bal] = await tx.select().from(stockBalances).where(and(eq(stockBalances.warehouseId, wh), eq(stockBalances.ingredientId, l.ingredientId)));
        const delta = D(l.newQty).minus(bal?.qty ?? 0);
        await postMovement(tx, { orgId: a.orgId, branchId: a.branchId!, warehouseId: wh, ingredientId: l.ingredientId, type: 'ADJUST', qty: delta, refType: 'adjust', refId: ref, reason: body.reason, createdBy: a.userId, approvedBy: approver });
      }
      await audit(tx, a, { action: 'stock.adjust', targetType: 'stock_adjust', targetId: ref, reason: body.reason, approverUserId: approver, data: { lines: body.lines } }, req.ip);
    });
    return { ref };
  });

  /** Move stock between warehouses of the same branch (cross-branch transfers: see /transfers). */
  app.post('/inventory/transfer', async (req) => {
    const a = requirePerm(req, 'stock.issue');
    const body = parse(z.object({ fromWarehouseId: uuid, toWarehouseId: uuid, note: z.string().max(300).optional(), lines: z.array(lineSchema).min(1).max(100) }), req.body);
    if (body.fromWarehouseId === body.toWarehouseId) throw badRequest('เลือกคลังปลายทางอื่น');
    const from = await warehouseFor(db, a, body.fromWarehouseId);
    const to = await warehouseFor(db, a, body.toWarehouseId);
    const ref = crypto.randomUUID();
    await db.transaction(async (tx) => {
      for (const l of body.lines) {
        await ownIngredient(tx, a.orgId, l.ingredientId);
        const base = await toBase(tx, l.ingredientId, l.qty, l.unit);
        const out = await postMovement(tx, { orgId: a.orgId, branchId: a.branchId!, warehouseId: from, ingredientId: l.ingredientId, type: 'TRANSFER_OUT', qty: base.neg(), refType: 'transfer', refId: ref, reason: body.note, createdBy: a.userId });
        await postMovement(tx, { orgId: a.orgId, branchId: a.branchId!, warehouseId: to, ingredientId: l.ingredientId, type: 'TRANSFER_IN', qty: base, unitCost: out!.unitCost, refType: 'transfer', refId: ref, reason: body.note, createdBy: a.userId });
      }
      await audit(tx, a, { action: 'stock.transfer', targetType: 'stock_transfer', targetId: ref, data: body }, req.ip);
    });
    return { ref };
  });

  /** Produce a sub-recipe batch: consume its ingredients, add the output at their combined cost. */
  app.post('/inventory/produce', async (req) => {
    const a = requirePerm(req, 'stock.issue');
    const body = parse(z.object({ outputIngredientId: uuid, batches: positive, warehouseId: uuid.optional() }), req.body);
    const wh = await warehouseFor(db, a, body.warehouseId);
    const [r] = await db.select().from(recipes).where(and(eq(recipes.outputIngredientId, body.outputIngredientId), eq(recipes.organizationId, a.orgId)));
    if (!r) throw notFound('สูตรของวัตถุดิบกึ่งสำเร็จ');
    const lines = await db.select().from(recipeLines).where(eq(recipeLines.recipeId, r.id));
    if (!lines.length) throw badRequest('สูตรยังไม่มีส่วนผสม');
    const ref = crypto.randomUUID();
    await db.transaction(async (tx) => {
      let total = D(0);
      for (const l of lines) {
        const out = await postMovement(tx, { orgId: a.orgId, branchId: a.branchId!, warehouseId: wh, ingredientId: l.ingredientId, type: 'PRODUCTION_OUT', qty: D(l.qtyBase).mul(body.batches).neg(), refType: 'production', refId: ref, createdBy: a.userId });
        total = total.plus(out!.unitCost.mul(D(l.qtyBase).mul(body.batches)));
      }
      const outQty = D(r.yieldQty).mul(body.batches);
      await postMovement(tx, { orgId: a.orgId, branchId: a.branchId!, warehouseId: wh, ingredientId: body.outputIngredientId, type: 'PRODUCTION_IN', qty: outQty, unitCost: total.div(outQty), refType: 'production', refId: ref, createdBy: a.userId });
      await audit(tx, a, { action: 'stock.produce', targetType: 'production', targetId: ref, data: body }, req.ip);
    });
    return { ref };
  });

  app.get('/inventory/movements', async (req) => {
    const a = requireAnyPerm(req, 'inventory.view', 'stock.receive');
    const branchId = requireBranch(a);
    const q = parse(
      z.object({ ingredientId: uuid.optional(), type: z.string().max(20).optional(), from: dateString.optional(), to: dateString.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      req.query,
    );
    const s = await branchSettings(db, branchId);
    const conds: SQL[] = [eq(stockMovements.branchId, branchId)];
    if (q.ingredientId) conds.push(eq(stockMovements.ingredientId, q.ingredientId));
    if (q.type) conds.push(eq(stockMovements.type, q.type as never));
    if (q.from && q.to) {
      const [f, t] = localRange(q.from, q.to, s.timezone);
      conds.push(gte(stockMovements.createdAt, f), lt(stockMovements.createdAt, t));
    }
    const rows = await db
      .select({ m: stockMovements, ingredient: ingredients.name, baseUnit: ingredients.baseUnit, by: users.name })
      .from(stockMovements)
      .innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId))
      .leftJoin(users, eq(users.id, stockMovements.createdBy))
      .where(and(...conds))
      .orderBy(desc(stockMovements.createdAt))
      .limit(q.limit);
    const showCost = a.permissions.has('report.view_profit') || a.permissions.has('inventory.manage');
    return { movements: rows.map((r) => ({ ...r.m, unitCost: showCost ? r.m.unitCost : null, value: showCost ? r.m.value : null, ingredient: r.ingredient, baseUnit: r.baseUnit, by: r.by })) };
  });

  app.get('/inventory/low-stock', async (req) => {
    const a = requireAnyPerm(req, 'inventory.view', 'purchase.view');
    const wh = await warehouseFor(db, a);
    const rows = await db
      .select({ ing: ingredients, qty: stockBalances.qty })
      .from(ingredients)
      .leftJoin(stockBalances, and(eq(stockBalances.ingredientId, ingredients.id), eq(stockBalances.warehouseId, wh)))
      .where(and(eq(ingredients.organizationId, a.orgId), isNull(ingredients.archivedAt), sql`${ingredients.reorderPoint} > 0 and coalesce(${stockBalances.qty}, 0) <= ${ingredients.reorderPoint}`));
    return { items: rows.map((r) => ({ id: r.ing.id, name: r.ing.name, baseUnit: r.ing.baseUnit, onHand: D(r.qty ?? 0).toFixed(4), reorderPoint: r.ing.reorderPoint, reorderQty: r.ing.reorderQty })) };
  });

  app.get('/inventory/expiring', async (req) => {
    const a = requirePerm(req, 'inventory.view');
    const wh = await warehouseFor(db, a);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(0).max(36500).default(7) }), req.query);
    const rows = await db
      .select({ lot: stockLots, name: ingredients.name, baseUnit: ingredients.baseUnit })
      .from(stockLots)
      .innerJoin(ingredients, eq(ingredients.id, stockLots.ingredientId))
      .where(and(eq(stockLots.warehouseId, wh), sql`${stockLots.remainingQty} > 0 and ${stockLots.expiryDate} <= current_date + ${days}::int`))
      .orderBy(asc(stockLots.expiryDate));
    return { lots: rows.map((r) => ({ ...r.lot, name: r.name, baseUnit: r.baseUnit })) };
  });

  // ---------- Stock counts ----------
  app.post('/inventory/counts', async (req) => {
    const a = requirePerm(req, 'stock.count');
    const body = parse(z.object({ warehouseId: uuid.optional(), note: z.string().max(300).optional(), ingredientIds: z.array(uuid).max(1000).optional() }), req.body);
    const wh = await warehouseFor(db, a, body.warehouseId);
    const ids =
      body.ingredientIds ??
      (await db.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.organizationId, a.orgId), isNull(ingredients.archivedAt)))).map((r) => r.id);
    const count = await db.transaction(async (tx) => {
      const [c] = await tx.insert(stockCounts).values({ organizationId: a.orgId, branchId: a.branchId!, warehouseId: wh, note: body.note, createdBy: a.userId }).returning();
      if (ids.length) await tx.insert(stockCountLines).values(ids.map((ingredientId) => ({ countId: c.id, ingredientId })));
      return c;
    });
    return count;
  });

  app.get('/inventory/counts', async (req) => {
    const a = requireAnyPerm(req, 'stock.count', 'inventory.view');
    const branchId = requireBranch(a);
    return { counts: await db.select().from(stockCounts).where(eq(stockCounts.branchId, branchId)).orderBy(desc(stockCounts.createdAt)).limit(50) };
  });

  /** Count sheet with theoretical (system) quantity and variance. Theoretical is live until posted. */
  app.get('/inventory/counts/:id', async (req) => {
    const a = requireAnyPerm(req, 'stock.count', 'inventory.view');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [c] = await db.select().from(stockCounts).where(and(eq(stockCounts.id, id), eq(stockCounts.branchId, requireBranch(a))));
    if (!c) throw notFound('ใบนับสต็อก');
    const lines = await db
      .select({ l: stockCountLines, name: ingredients.name, baseUnit: ingredients.baseUnit, liveQty: stockBalances.qty, liveCost: stockBalances.avgCost })
      .from(stockCountLines)
      .innerJoin(ingredients, eq(ingredients.id, stockCountLines.ingredientId))
      .leftJoin(stockBalances, and(eq(stockBalances.ingredientId, stockCountLines.ingredientId), eq(stockBalances.warehouseId, c.warehouseId)))
      .where(eq(stockCountLines.countId, id))
      .orderBy(asc(ingredients.name));
    const showCost = a.permissions.has('report.view_profit') || a.permissions.has('inventory.manage');
    return {
      count: c,
      lines: lines.map((r) => {
        const theo = D(c.status === 'POSTED' ? (r.l.theoreticalQty ?? 0) : (r.liveQty ?? 0));
        const counted = r.l.countedQty == null ? null : D(r.l.countedQty);
        const variance = counted ? counted.minus(theo) : null;
        const unitCost = D(c.status === 'POSTED' ? (r.l.unitCost ?? 0) : (r.liveCost ?? 0));
        return {
          ingredientId: r.l.ingredientId,
          name: r.name,
          baseUnit: r.baseUnit,
          theoreticalQty: theo.toFixed(4),
          countedQty: counted?.toFixed(4) ?? null,
          varianceQty: variance?.toFixed(4) ?? null,
          varianceValue: variance && showCost ? variance.mul(unitCost).toFixed(2) : null,
        };
      }),
    };
  });

  app.put('/inventory/counts/:id', async (req) => {
    const a = requirePerm(req, 'stock.count');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ lines: z.array(z.object({ ingredientId: uuid, countedQty: nonNegative.nullable() })).max(1000) }), req.body);
    const [c] = await db.select().from(stockCounts).where(and(eq(stockCounts.id, id), eq(stockCounts.branchId, requireBranch(a))));
    if (!c) throw notFound('ใบนับสต็อก');
    if (c.status !== 'DRAFT') throw conflict('ใบนับนี้บันทึกแล้ว');
    await db.transaction(async (tx) => {
      for (const l of body.lines)
        await tx
          .update(stockCountLines)
          .set({ countedQty: l.countedQty })
          .where(and(eq(stockCountLines.countId, id), eq(stockCountLines.ingredientId, l.ingredientId)));
    });
    return { ok: true };
  });

  /** Post a count: snapshot theoretical qty, write COUNT movements for each variance. */
  app.post('/inventory/counts/:id/post', async (req) => {
    const a = requirePerm(req, 'stock.count');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ approval: approvalSchema }), req.body ?? {});
    await db.transaction(async (tx) => {
      const [c] = await tx.select().from(stockCounts).where(and(eq(stockCounts.id, id), eq(stockCounts.branchId, requireBranch(a)))).for('update');
      if (!c) throw notFound('ใบนับสต็อก');
      if (c.status !== 'DRAFT') throw conflict('ใบนับนี้บันทึกแล้ว');
      // Posting changes on-hand like an adjustment, so it needs stock.adjust (or a manager PIN).
      const approver = await authorizeSensitive(tx, a, 'stock.adjust', body.approval);
      const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, id));
      const counted = lines.filter((l) => l.countedQty != null);
      if (counted.length === 0) throw badRequest('ยังไม่ได้กรอกจำนวนที่นับ');
      for (const l of counted) {
        await tx.insert(stockBalances).values({ warehouseId: c.warehouseId, ingredientId: l.ingredientId }).onConflictDoNothing();
        const [bal] = await tx.select().from(stockBalances).where(and(eq(stockBalances.warehouseId, c.warehouseId), eq(stockBalances.ingredientId, l.ingredientId)));
        const variance = D(l.countedQty!).minus(bal.qty);
        await tx
          .update(stockCountLines)
          .set({ theoreticalQty: bal.qty, varianceQty: variance.toFixed(4), unitCost: bal.avgCost })
          .where(and(eq(stockCountLines.countId, id), eq(stockCountLines.ingredientId, l.ingredientId)));
        await postMovement(tx, { orgId: a.orgId, branchId: c.branchId, warehouseId: c.warehouseId, ingredientId: l.ingredientId, type: 'COUNT', qty: variance, refType: 'stock_count', refId: id, reason: 'ปรับตามการนับสต็อก', idempotencyKey: `COUNT:${id}:${l.ingredientId}`, createdBy: a.userId, approvedBy: approver });
      }
      await tx.update(stockCounts).set({ status: 'POSTED', postedAt: new Date(), postedBy: a.userId }).where(eq(stockCounts.id, id));
      await audit(tx, a, { action: 'stock.count_posted', targetType: 'stock_count', targetId: id, approverUserId: approver, data: { lines: counted.length } }, req.ip);
    });
    return { ok: true };
  });

  app.post('/inventory/reconcile', async (req) => {
    const a = requirePerm(req, 'inventory.manage');
    const branchId = requireBranch(a);
    const whs = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.branchId, branchId));
    const drift = await db.transaction((tx) => reconcile(tx, whs.map((w) => w.id)));
    if (drift.length) await audit(db, a, { action: 'stock.reconcile', data: { drift } }, req.ip);
    return { drift };
  });

}
