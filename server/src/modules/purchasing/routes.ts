import Decimal from 'decimal.js';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateString, decimalString, nonEmpty, reasonSchema, satang, uuid } from '@shared/validation';
import type { DbOrTx } from '../../db/client';
import {
  branches,
  goodsReceipts,
  grLines,
  ingredients,
  poLines,
  purchaseOrders,
  stockBalances,
  stockMovements,
  supplierItems,
  supplierPayments,
  supplierReturnLines,
  supplierReturns,
  suppliers,
  users,
  warehouses,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAnyPerm, requireBranch, requirePerm, type AuthContext } from '../../lib/auth';
import { badRequest, conflict, isUniqueViolation, notFound, parse, unprocessable } from '../../lib/errors';
import { addDays, businessDate } from '../../lib/time';
import { D, defaultWarehouse, postMovement, toBase } from '../inventory/ledger';
import { branchSettings } from '../menu/service';
import { nextDocNo } from '../payments/service';

const positive = decimalString.refine((v) => new Decimal(v).gt(0), 'ต้องมากกว่า 0');
const nonNeg = decimalString.refine((v) => new Decimal(v).gte(0), 'ต้องไม่ติดลบ');

const supplierBody = z.object({
  name: nonEmpty(120),
  contactName: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  lineId: z.string().trim().max(60).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  taxId: z.string().trim().max(20).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  note: z.string().max(500).nullable().optional(),
  items: z
    .array(z.object({ ingredientId: uuid, unit: z.string().min(1).max(20), priceSatang: satang, supplierSku: z.string().max(40).nullable().optional(), leadTimeDays: z.number().int().min(0).max(90).default(1), isPreferred: z.boolean().default(false) }))
    .max(300)
    .default([]),
});

async function docNo(db: DbOrTx, branchId: string, prefix: string, type: string) {
  const [b] = await db.select({ code: branches.code, timezone: branches.timezone }).from(branches).where(eq(branches.id, branchId));
  const year = businessDate(b.timezone).slice(0, 4);
  return `${prefix}${b.code}${year}-${String(await nextDocNo(db, branchId, type, year)).padStart(5, '0')}`;
}

async function ownSupplier(db: DbOrTx, orgId: string, id: string) {
  const [s] = await db.select().from(suppliers).where(and(eq(suppliers.id, id), eq(suppliers.organizationId, orgId)));
  if (!s) throw notFound('ซัพพลายเออร์');
  return s;
}

async function loadPo(db: DbOrTx, a: AuthContext, id: string, lock = false) {
  const q = db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.organizationId, a.orgId), eq(purchaseOrders.branchId, requireBranch(a))));
  const [po] = lock ? await q.for('update') : await q;
  if (!po) throw notFound('ใบสั่งซื้อ');
  return po;
}

/** Average daily consumption (sales, issues, waste, production) over the last N days, base units. */
async function avgDailyUsage(db: DbOrTx, branchId: string, ingredientIds: string[], days = 14) {
  if (!ingredientIds.length) return new Map<string, Decimal>();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({ ingredientId: stockMovements.ingredientId, used: sql<string>`-sum(${stockMovements.qty})` })
    .from(stockMovements)
    .where(and(eq(stockMovements.branchId, branchId), inArray(stockMovements.ingredientId, ingredientIds), inArray(stockMovements.type, ['SALE', 'SALE_REVERSAL', 'ISSUE', 'WASTE', 'PRODUCTION_OUT']), gte(stockMovements.createdAt, since)))
    .groupBy(stockMovements.ingredientId);
  return new Map(rows.map((r) => [r.ingredientId, Decimal.max(0, D(r.used ?? 0).div(days))]));
}

export default async function purchasingRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  // ---------- Suppliers ----------
  app.get('/purchasing/suppliers', async (req) => {
    const a = requireAnyPerm(req, 'purchase.view', 'supplier.manage', 'stock.receive');
    const list = await db.select().from(suppliers).where(eq(suppliers.organizationId, a.orgId)).orderBy(asc(suppliers.name));
    const items = list.length ? await db.select().from(supplierItems).where(inArray(supplierItems.supplierId, list.map((s) => s.id))) : [];
    return { suppliers: list.map((s) => ({ ...s, items: items.filter((i) => i.supplierId === s.id).map((i) => ({ ...i, isPreferred: !!i.isPreferred })) })) };
  });

  const saveSupplierItems = async (tx: DbOrTx, a: AuthContext, supplierId: string, items: z.infer<typeof supplierBody>['items']) => {
    await tx.delete(supplierItems).where(eq(supplierItems.supplierId, supplierId));
    for (const it of items) {
      const [ing] = await tx.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.id, it.ingredientId), eq(ingredients.organizationId, a.orgId)));
      if (!ing) throw badRequest('วัตถุดิบไม่ถูกต้อง');
      await toBase(tx, it.ingredientId, 1, it.unit); // validates the unit exists
    }
    if (items.length) await tx.insert(supplierItems).values(items.map((i) => ({ ...i, supplierId, isPreferred: i.isPreferred ? 1 : 0 })));
  };

  app.post('/purchasing/suppliers', async (req) => {
    const a = requirePerm(req, 'supplier.manage');
    const body = parse(supplierBody, req.body);
    try {
      return await db.transaction(async (tx) => {
        const { items, ...cols } = body;
        const [s] = await tx.insert(suppliers).values({ organizationId: a.orgId, ...cols }).returning();
        await saveSupplierItems(tx, a, s.id, items);
        await audit(tx, a, { action: 'supplier.create', targetType: 'supplier', targetId: s.id, data: { name: s.name }, branchId: null }, req.ip);
        return s;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('มีซัพพลายเออร์ชื่อนี้แล้ว');
      throw e;
    }
  });

  app.put('/purchasing/suppliers/:id', async (req) => {
    const a = requirePerm(req, 'supplier.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(supplierBody.extend({ archived: z.boolean().optional() }), req.body);
    await ownSupplier(db, a.orgId, id);
    await db.transaction(async (tx) => {
      const { items, archived, ...cols } = body;
      await tx
        .update(suppliers)
        .set({ ...cols, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
        .where(eq(suppliers.id, id));
      await saveSupplierItems(tx, a, id, items);
      await audit(tx, a, { action: 'supplier.update', targetType: 'supplier', targetId: id, data: { name: body.name, items: items.length }, branchId: null }, req.ip);
    });
    return { ok: true };
  });

  /** Compare supplier prices for an ingredient, normalised to price per base unit. */
  app.get('/purchasing/price-compare', async (req) => {
    const a = requireAnyPerm(req, 'purchase.view', 'supplier.manage');
    const { ingredientId } = parse(z.object({ ingredientId: uuid }), req.query);
    const rows = await db
      .select({ si: supplierItems, supplier: suppliers.name })
      .from(supplierItems)
      .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
      .where(and(eq(supplierItems.ingredientId, ingredientId), eq(suppliers.organizationId, a.orgId), isNull(suppliers.archivedAt)));
    const out = [];
    for (const r of rows) {
      const perUnit = await toBase(db, ingredientId, 1, r.si.unit);
      out.push({ supplierId: r.si.supplierId, supplier: r.supplier, unit: r.si.unit, priceSatang: r.si.priceSatang, pricePerBaseSatang: Number(D(r.si.priceSatang).div(perUnit).toFixed(4)), leadTimeDays: r.si.leadTimeDays, isPreferred: !!r.si.isPreferred });
    }
    return { prices: out.sort((x, y) => x.pricePerBaseSatang - y.pricePerBaseSatang) };
  });

  // ---------- Purchase requests / orders ----------
  const poBody = z.object({
    supplierId: uuid,
    warehouseId: uuid.optional(),
    expectedDate: dateString.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    lines: z.array(z.object({ ingredientId: uuid, qty: positive, unit: z.string().min(1).max(20), unitPriceSatang: satang })).min(1).max(200),
  });

  const writeLines = async (tx: DbOrTx, a: AuthContext, poId: string, lines: z.infer<typeof poBody>['lines']) => {
    await tx.delete(poLines).where(eq(poLines.poId, poId));
    let total = D(0);
    for (const l of lines) {
      const [ing] = await tx.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.id, l.ingredientId), eq(ingredients.organizationId, a.orgId)));
      if (!ing) throw badRequest('วัตถุดิบไม่ถูกต้อง');
      const base = await toBase(tx, l.ingredientId, l.qty, l.unit);
      const lineTotal = D(l.qty).mul(l.unitPriceSatang).toDecimalPlaces(0);
      total = total.plus(lineTotal);
      await tx.insert(poLines).values({ poId, ingredientId: l.ingredientId, qty: l.qty, unit: l.unit, qtyBase: base.toFixed(4), unitPriceSatang: l.unitPriceSatang, lineTotalSatang: lineTotal.toNumber() });
    }
    await tx.update(purchaseOrders).set({ totalSatang: total.toNumber() }).where(eq(purchaseOrders.id, poId));
  };

  app.get('/purchasing/orders', async (req) => {
    const a = requireAnyPerm(req, 'purchase.view', 'stock.receive');
    const branchId = requireBranch(a);
    const q = parse(z.object({ status: z.string().max(20).optional() }), req.query);
    const rows = await db
      .select({ po: purchaseOrders, supplier: suppliers.name, createdByName: users.name })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .leftJoin(users, eq(users.id, purchaseOrders.createdBy))
      .where(and(eq(purchaseOrders.branchId, branchId), q.status ? inArray(purchaseOrders.status, q.status.split(',') as never) : undefined))
      .orderBy(desc(purchaseOrders.createdAt))
      .limit(200);
    return { orders: rows.map((r) => ({ ...r.po, supplier: r.supplier, createdByName: r.createdByName })) };
  });

  app.get('/purchasing/orders/:id', async (req) => {
    const a = requireAnyPerm(req, 'purchase.view', 'stock.receive');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const po = await loadPo(db, a, id);
    const lines = await db
      .select({ l: poLines, name: ingredients.name, baseUnit: ingredients.baseUnit })
      .from(poLines)
      .innerJoin(ingredients, eq(ingredients.id, poLines.ingredientId))
      .where(eq(poLines.poId, id));
    const receipts = await db.select().from(goodsReceipts).where(eq(goodsReceipts.poId, id)).orderBy(asc(goodsReceipts.postedAt));
    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, po.supplierId));
    return { ...po, supplier, lines: lines.map((r) => ({ ...r.l, name: r.name, baseUnit: r.baseUnit })), receipts };
  });

  app.post('/purchasing/orders', async (req) => {
    const a = requirePerm(req, 'purchase.create');
    const branchId = requireBranch(a);
    const body = parse(poBody, req.body);
    await ownSupplier(db, a.orgId, body.supplierId);
    const wh = body.warehouseId ?? (await defaultWarehouse(db, a.orgId, branchId));
    if (body.warehouseId) {
      const [w] = await db.select().from(warehouses).where(and(eq(warehouses.id, wh), eq(warehouses.branchId, branchId)));
      if (!w) throw badRequest('คลังไม่ถูกต้อง');
    }
    const po = await db.transaction(async (tx) => {
      const [po] = await tx
        .insert(purchaseOrders)
        .values({ organizationId: a.orgId, branchId, poNo: await docNo(tx, branchId, 'PO', 'PO'), supplierId: body.supplierId, warehouseId: wh, expectedDate: body.expectedDate ?? null, note: body.note ?? null, createdBy: a.userId })
        .returning();
      await writeLines(tx, a, po.id, body.lines);
      await audit(tx, a, { action: 'po.create', targetType: 'purchase_order', targetId: po.id, data: { poNo: po.poNo, lines: body.lines.length } }, req.ip);
      return po;
    });
    return po;
  });

  app.put('/purchasing/orders/:id', async (req) => {
    const a = requirePerm(req, 'purchase.create');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(poBody, req.body);
    await ownSupplier(db, a.orgId, body.supplierId);
    await db.transaction(async (tx) => {
      const po = await loadPo(tx, a, id, true);
      if (!['DRAFT', 'SUBMITTED', 'REJECTED'].includes(po.status)) throw conflict('แก้ไขได้เฉพาะใบที่ยังไม่อนุมัติ');
      await tx.update(purchaseOrders).set({ supplierId: body.supplierId, expectedDate: body.expectedDate ?? null, note: body.note ?? null, status: 'DRAFT' }).where(eq(purchaseOrders.id, id));
      await writeLines(tx, a, id, body.lines);
      await audit(tx, a, { action: 'po.update', targetType: 'purchase_order', targetId: id }, req.ip);
    });
    return { ok: true };
  });

  /** Workflow transitions: submit (PR) → approve/reject → mark ordered; cancel before receipt. */
  app.post('/purchasing/orders/:id/:action', async (req) => {
    const { id, action } = parse(z.object({ id: uuid, action: z.enum(['submit', 'approve', 'reject', 'order', 'cancel']) }), req.params);
    const perm = action === 'approve' || action === 'reject' ? 'purchase.approve' : 'purchase.create';
    const a = requirePerm(req, perm);
    const body = parse(z.object({ reason: z.string().max(300).optional() }), req.body ?? {});
    const allowed: Record<string, string[]> = {
      submit: ['DRAFT', 'REJECTED'],
      approve: ['SUBMITTED', 'DRAFT'],
      reject: ['SUBMITTED'],
      order: ['APPROVED'],
      cancel: ['DRAFT', 'SUBMITTED', 'APPROVED', 'ORDERED', 'REJECTED'],
    };
    const next = { submit: 'SUBMITTED', approve: 'APPROVED', reject: 'REJECTED', order: 'ORDERED', cancel: 'CANCELLED' }[action];
    await db.transaction(async (tx) => {
      const po = await loadPo(tx, a, id, true);
      if (!allowed[action].includes(po.status)) throw conflict(`ใบสั่งซื้อสถานะ ${po.status} ทำรายการ "${action}" ไม่ได้`, 'INVALID_STATE');
      if (action === 'reject' && !body.reason) throw badRequest('ระบุเหตุผลที่ไม่อนุมัติ');
      const now = new Date();
      await tx
        .update(purchaseOrders)
        .set({
          status: next as never,
          ...(action === 'submit' ? { submittedAt: now } : {}),
          ...(action === 'approve' ? { approvedBy: a.userId, approvedAt: now, rejectedReason: null } : {}),
          ...(action === 'reject' ? { rejectedReason: body.reason } : {}),
          ...(action === 'order' ? { orderedAt: now } : {}),
        })
        .where(eq(purchaseOrders.id, id));
      await audit(tx, a, { action: `po.${action}`, targetType: 'purchase_order', targetId: id, reason: body.reason, data: { poNo: po.poNo, from: po.status, to: next } }, req.ip);
    });
    return { ok: true, status: next };
  });

  // ---------- Goods receipt ----------
  /**
   * Post a goods receipt: accepted quantities enter the stock ledger (PURCHASE) at the invoice price,
   * rejected/damaged quantities are recorded but not stocked. All-or-nothing in one transaction;
   * the client-supplied id makes double-posting impossible.
   */
  app.post('/purchasing/receipts', async (req) => {
    const a = requirePerm(req, 'stock.receive');
    const branchId = requireBranch(a);
    const body = parse(
      z.object({
        id: uuid,
        poId: uuid.optional(),
        supplierId: uuid,
        invoiceNo: z.string().trim().max(60).optional(),
        invoiceDate: dateString.optional(),
        note: z.string().max(500).optional(),
        lines: z
          .array(
            z.object({
              poLineId: uuid.optional(),
              ingredientId: uuid,
              unit: z.string().min(1).max(20),
              deliveredQty: nonNeg,
              rejectedQty: nonNeg.default('0'),
              rejectReason: z.string().max(200).optional(),
              unitPriceSatang: satang,
              lotNo: z.string().max(40).optional(),
              expiryDate: dateString.optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      req.body,
    );
    const lineKeys = body.lines.map((l) => l.poLineId ?? `ing:${l.ingredientId}`);
    if (new Set(lineKeys).size !== lineKeys.length) throw badRequest('มีรายการซ้ำในใบรับของ รวมเป็นบรรทัดเดียว');
    const [existing] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, body.id));
    if (existing) {
      if (existing.branchId !== branchId) throw conflict('รหัสใบรับของชนกัน');
      return { ...existing, replay: true };
    }
    const supplier = await ownSupplier(db, a.orgId, body.supplierId);
    try {
      return await db.transaction(async (tx) => {
        let po = null;
        let lines: (typeof poLines.$inferSelect)[] = [];
        if (body.poId) {
          po = await loadPo(tx, a, body.poId, true);
          if (!['APPROVED', 'ORDERED', 'PARTIAL'].includes(po.status)) throw conflict('รับของได้เฉพาะใบสั่งซื้อที่อนุมัติแล้ว', 'PO_NOT_RECEIVABLE');
          if (po.supplierId !== body.supplierId) throw badRequest('ซัพพลายเออร์ไม่ตรงกับใบสั่งซื้อ');
          lines = await tx.select().from(poLines).where(eq(poLines.poId, po.id)).for('update');
        }
        const wh = po?.warehouseId ?? (await defaultWarehouse(tx, a.orgId, branchId));
        const grNo = await docNo(tx, branchId, 'GR', 'GR');
        const s = await branchSettings(tx, branchId);
        const today = businessDate(s.timezone);
        const prepared = [];
        let total = D(0);
        for (const l of body.lines) {
          if (D(l.rejectedQty).gt(l.deliveredQty)) throw badRequest('จำนวนที่ปฏิเสธมากกว่าที่ส่งมา');
          if (D(l.rejectedQty).gt(0) && !l.rejectReason) throw badRequest('ระบุเหตุผลที่ปฏิเสธ (เสีย/ไม่ครบ/ผิดสเปก)');
          const accepted = D(l.deliveredQty).minus(l.rejectedQty);
          const acceptedBase = await toBase(tx, l.ingredientId, accepted, l.unit);
          const rejectedBase = await toBase(tx, l.ingredientId, l.rejectedQty, l.unit);
          let poLine = null;
          if (l.poLineId) {
            poLine = lines.find((x) => x.id === l.poLineId);
            if (!poLine || poLine.ingredientId !== l.ingredientId) throw badRequest('รายการไม่ตรงกับใบสั่งซื้อ');
            const outstanding = D(poLine.qtyBase).minus(poLine.receivedQtyBase);
            if (acceptedBase.gt(outstanding)) throw unprocessable('รับเกินจำนวนที่สั่งซื้อ', 'OVER_RECEIPT', { poLineId: poLine.id, outstanding: outstanding.toString() });
            poLine.receivedQtyBase = D(poLine.receivedQtyBase).plus(acceptedBase).toFixed(4);
          } else if (po) throw badRequest('รายการรับของต้องอ้างอิงรายการในใบสั่งซื้อ');
          const lineTotal = accepted.mul(l.unitPriceSatang).toDecimalPlaces(0);
          total = total.plus(lineTotal);
          prepared.push({ l, acceptedBase, rejectedBase, lineTotal, poLine });
        }
        const [gr] = await tx
          .insert(goodsReceipts)
          .values({
            id: body.id,
            organizationId: a.orgId,
            branchId,
            grNo,
            poId: po?.id ?? null,
            supplierId: supplier.id,
            warehouseId: wh,
            invoiceNo: body.invoiceNo ?? null,
            invoiceDate: body.invoiceDate ?? null,
            dueDate: addDays(body.invoiceDate ?? today, supplier.paymentTermsDays),
            note: body.note ?? null,
            totalSatang: total.toNumber(),
            receivedBy: a.userId,
          })
          .returning();
        for (const p of prepared) {
          await tx.insert(grLines).values({
            grId: gr.id,
            poLineId: p.poLine?.id ?? null,
            ingredientId: p.l.ingredientId,
            unit: p.l.unit,
            deliveredQty: p.l.deliveredQty,
            acceptedQtyBase: p.acceptedBase.toFixed(4),
            rejectedQtyBase: p.rejectedBase.toFixed(4),
            rejectReason: p.l.rejectReason ?? null,
            unitPriceSatang: p.l.unitPriceSatang,
            lineTotalSatang: p.lineTotal.toNumber(),
          });
          if (p.acceptedBase.gt(0)) {
            await postMovement(tx, {
              orgId: a.orgId,
              branchId,
              warehouseId: wh,
              ingredientId: p.l.ingredientId,
              type: 'PURCHASE',
              qty: p.acceptedBase,
              unitCost: p.lineTotal.div(p.acceptedBase),
              refType: 'goods_receipt',
              refId: gr.id,
              reason: `${grNo} ${supplier.name}`,
              idempotencyKey: `GR:${gr.id}:${p.l.ingredientId}:${p.poLine?.id ?? ''}`,
              createdBy: a.userId,
              lot: { lotNo: p.l.lotNo, expiryDate: p.l.expiryDate },
            });
          }
          if (p.poLine) await tx.update(poLines).set({ receivedQtyBase: p.poLine.receivedQtyBase }).where(eq(poLines.id, p.poLine.id));
        }
        if (po) {
          const after = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
          const complete = after.every((x) => D(x.receivedQtyBase).gte(x.qtyBase));
          await tx.update(purchaseOrders).set({ status: complete ? 'RECEIVED' : 'PARTIAL' }).where(eq(purchaseOrders.id, po.id));
        }
        await audit(tx, a, { action: 'gr.post', targetType: 'goods_receipt', targetId: gr.id, data: { grNo, poId: po?.id, total: total.toNumber(), rejected: prepared.filter((p) => p.rejectedBase.gt(0)).length } }, req.ip);
        return gr;
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const [dup] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, body.id));
        if (dup) return { ...dup, replay: true };
      }
      throw e;
    }
  });

  app.get('/purchasing/receipts', async (req) => {
    const a = requireAnyPerm(req, 'purchase.view', 'stock.receive');
    const branchId = requireBranch(a);
    const rows = await db
      .select({ gr: goodsReceipts, supplier: suppliers.name, by: users.name })
      .from(goodsReceipts)
      .innerJoin(suppliers, eq(suppliers.id, goodsReceipts.supplierId))
      .leftJoin(users, eq(users.id, goodsReceipts.receivedBy))
      .where(eq(goodsReceipts.branchId, branchId))
      .orderBy(desc(goodsReceipts.postedAt))
      .limit(200);
    return { receipts: rows.map((r) => ({ ...r.gr, supplier: r.supplier, receivedByName: r.by })) };
  });

  app.get('/purchasing/receipts/:id', async (req) => {
    const a = requireAnyPerm(req, 'purchase.view', 'stock.receive');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [gr] = await db.select().from(goodsReceipts).where(and(eq(goodsReceipts.id, id), eq(goodsReceipts.branchId, requireBranch(a))));
    if (!gr) throw notFound('ใบรับของ');
    const lines = await db.select({ l: grLines, name: ingredients.name, baseUnit: ingredients.baseUnit }).from(grLines).innerJoin(ingredients, eq(ingredients.id, grLines.ingredientId)).where(eq(grLines.grId, id));
    return { ...gr, lines: lines.map((r) => ({ ...r.l, name: r.name, baseUnit: r.baseUnit })) };
  });

  // ---------- Supplier returns ----------
  app.post('/purchasing/returns', async (req) => {
    const a = requirePerm(req, 'stock.receive');
    const branchId = requireBranch(a);
    const body = parse(
      z.object({ id: uuid, supplierId: uuid, grId: uuid.optional(), reason: reasonSchema, lines: z.array(z.object({ ingredientId: uuid, qty: positive, unit: z.string().min(1).max(20) })).min(1).max(100) }),
      req.body,
    );
    if (new Set(body.lines.map((l) => l.ingredientId)).size !== body.lines.length) throw badRequest('มีวัตถุดิบซ้ำในใบคืน รวมเป็นบรรทัดเดียว');
    const [dup] = await db.select().from(supplierReturns).where(eq(supplierReturns.id, body.id));
    if (dup) return { ...dup, replay: true };
    await ownSupplier(db, a.orgId, body.supplierId);
    return db.transaction(async (tx) => {
      let grLinesFor: (typeof grLines.$inferSelect)[] = [];
      if (body.grId) {
        const [gr] = await tx.select().from(goodsReceipts).where(and(eq(goodsReceipts.id, body.grId), eq(goodsReceipts.branchId, branchId)));
        if (!gr || gr.supplierId !== body.supplierId) throw badRequest('ใบรับของไม่ถูกต้อง');
        grLinesFor = await tx.select().from(grLines).where(eq(grLines.grId, gr.id));
      }
      const wh = await defaultWarehouse(tx, a.orgId, branchId);
      const returnNo = await docNo(tx, branchId, 'RT', 'RETURN');
      let credit = 0;
      const prepared = [];
      for (const l of body.lines) {
        const base = await toBase(tx, l.ingredientId, l.qty, l.unit);
        const grl = grLinesFor.find((g) => g.ingredientId === l.ingredientId);
        if (body.grId && !grl) throw badRequest('วัตถุดิบนี้ไม่อยู่ในใบรับของ');
        if (grl) {
          // Cap by what was received on this GR minus everything already returned against it.
          const [{ prior }] = await tx
            .select({ prior: sql<string>`coalesce(sum(${supplierReturnLines.qtyBase}), 0)` })
            .from(supplierReturnLines)
            .innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.returnId))
            .where(and(eq(supplierReturns.grId, body.grId!), eq(supplierReturnLines.ingredientId, l.ingredientId)));
          if (base.plus(prior).gt(grl.acceptedQtyBase)) throw unprocessable('คืนเกินจำนวนที่รับเข้า (รวมที่คืนไปแล้ว)', 'OVER_RETURN');
        }
        // Credit at the GR price when known, otherwise at current average cost.
        const posted = await postMovement(tx, { orgId: a.orgId, branchId, warehouseId: wh, ingredientId: l.ingredientId, type: 'RETURN', qty: base.neg(), refType: 'supplier_return', refId: body.id, reason: body.reason, idempotencyKey: `RT:${body.id}:${l.ingredientId}`, createdBy: a.userId });
        const lineCredit = grl ? D(grl.lineTotalSatang).div(grl.acceptedQtyBase).mul(base).toDecimalPlaces(0).toNumber() : posted!.unitCost.mul(base).toDecimalPlaces(0).toNumber();
        credit += lineCredit;
        prepared.push({ ...l, qtyBase: base.toFixed(4), creditSatang: lineCredit });
      }
      const [rt] = await tx.insert(supplierReturns).values({ id: body.id, organizationId: a.orgId, branchId, returnNo, supplierId: body.supplierId, grId: body.grId ?? null, reason: body.reason, creditSatang: credit, createdBy: a.userId }).returning();
      await tx.insert(supplierReturnLines).values(prepared.map((p) => ({ returnId: rt.id, ingredientId: p.ingredientId, qty: p.qty, unit: p.unit, qtyBase: p.qtyBase, creditSatang: p.creditSatang })));
      await audit(tx, a, { action: 'supplier.return', targetType: 'supplier_return', targetId: rt.id, reason: body.reason, data: { returnNo, credit } }, req.ip);
      return rt;
    });
  });

  // ---------- Payables ----------
  app.get('/purchasing/payables', async (req) => {
    const a = requirePerm(req, 'purchase.view');
    const branchId = requireBranch(a);
    const grs = await db.select().from(goodsReceipts).where(eq(goodsReceipts.branchId, branchId));
    const pays = await db.select().from(supplierPayments).where(eq(supplierPayments.branchId, branchId));
    const rts = await db.select().from(supplierReturns).where(eq(supplierReturns.branchId, branchId));
    const sups = await db.select().from(suppliers).where(eq(suppliers.organizationId, a.orgId));
    const today = businessDate((await branchSettings(db, branchId)).timezone);
    return {
      suppliers: sups
        .map((s) => {
          const g = grs.filter((x) => x.supplierId === s.id);
          const billed = g.reduce((n, x) => n + x.totalSatang, 0);
          const paid = pays.filter((x) => x.supplierId === s.id).reduce((n, x) => n + x.amountSatang, 0);
          const credited = rts.filter((x) => x.supplierId === s.id).reduce((n, x) => n + x.creditSatang, 0);
          const overdue = g.filter((x) => x.dueDate && x.dueDate < today).reduce((n, x) => n + x.totalSatang, 0);
          return { supplierId: s.id, name: s.name, billedSatang: billed, paidSatang: paid, creditSatang: credited, outstandingSatang: billed - paid - credited, overdueBilledSatang: overdue };
        })
        .filter((x) => x.billedSatang > 0),
      receipts: grs.map((x) => ({ id: x.id, grNo: x.grNo, supplierId: x.supplierId, totalSatang: x.totalSatang, dueDate: x.dueDate, invoiceNo: x.invoiceNo, paidSatang: pays.filter((p) => p.grId === x.id).reduce((n, p) => n + p.amountSatang, 0) })),
    };
  });

  app.post('/purchasing/payments', async (req) => {
    const a = requirePerm(req, 'purchase.approve');
    const branchId = requireBranch(a);
    const body = parse(z.object({ id: uuid, supplierId: uuid, grId: uuid.optional(), amountSatang: satang.min(1), method: z.enum(['CASH', 'TRANSFER', 'CHEQUE']), reference: z.string().max(60).optional(), paidAt: dateString }), req.body);
    const [dup] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, body.id));
    if (dup) return dup;
    await ownSupplier(db, a.orgId, body.supplierId);
    if (body.grId) {
      const [gr] = await db.select().from(goodsReceipts).where(and(eq(goodsReceipts.id, body.grId), eq(goodsReceipts.branchId, branchId)));
      if (!gr || gr.supplierId !== body.supplierId) throw badRequest('ใบรับของไม่ถูกต้อง');
      const [{ paid }] = await db.select({ paid: sql<number>`coalesce(sum(${supplierPayments.amountSatang}),0)::int` }).from(supplierPayments).where(eq(supplierPayments.grId, gr.id));
      if (paid + body.amountSatang > gr.totalSatang) throw unprocessable('ยอดจ่ายเกินยอดใบรับของ', 'OVERPAYMENT');
    }
    const [p] = await db.insert(supplierPayments).values({ ...body, organizationId: a.orgId, branchId, grId: body.grId ?? null, reference: body.reference ?? null, createdBy: a.userId }).returning();
    await audit(db, a, { action: 'supplier.payment', targetType: 'supplier', targetId: body.supplierId, data: { amount: body.amountSatang, grId: body.grId, method: body.method } }, req.ip);
    return p;
  });

  // ---------- Replenishment suggestions ----------
  app.get('/purchasing/suggestions', async (req) => {
    const a = requireAnyPerm(req, 'purchase.view', 'purchase.create');
    const branchId = requireBranch(a);
    const wh = await defaultWarehouse(db, a.orgId, branchId);
    const ings = await db
      .select({ ing: ingredients, qty: stockBalances.qty })
      .from(ingredients)
      .leftJoin(stockBalances, and(eq(stockBalances.ingredientId, ingredients.id), eq(stockBalances.warehouseId, wh)))
      .where(and(eq(ingredients.organizationId, a.orgId), isNull(ingredients.archivedAt), eq(ingredients.isSubRecipe, false)));
    const usage = await avgDailyUsage(db, branchId, ings.map((i) => i.ing.id));
    const offers = await db
      .select({ si: supplierItems, name: suppliers.name })
      .from(supplierItems)
      .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
      .where(and(eq(suppliers.organizationId, a.orgId), isNull(suppliers.archivedAt)));
    const out = [];
    for (const { ing, qty } of ings) {
      const onHand = D(qty ?? 0);
      const daily = usage.get(ing.id) ?? D(0);
      const my = offers.filter((o) => o.si.ingredientId === ing.id);
      const best = my.find((o) => o.si.isPreferred) ?? my.sort((x, y) => x.si.priceSatang - y.si.priceSatang)[0];
      const lead = best?.si.leadTimeDays ?? 1;
      const belowReorder = D(ing.reorderPoint).gt(0) && onHand.lte(ing.reorderPoint);
      const coverDays = daily.gt(0) ? onHand.div(daily) : null;
      if (!belowReorder && !(coverDays && coverDays.lt(lead + 2))) continue;
      // Order enough for ~7 days beyond lead time, but at least the configured reorder quantity.
      const target = daily.mul(lead + 7).plus(ing.reorderPoint);
      let needBase = Decimal.max(D(ing.reorderQty), target.minus(onHand));
      if (needBase.lte(0)) needBase = D(ing.reorderQty).gt(0) ? D(ing.reorderQty) : D(1);
      let suggestion = null;
      if (best) {
        const per = await toBase(db, ing.id, 1, best.si.unit);
        const units = needBase.div(per).ceil();
        suggestion = { supplierId: best.si.supplierId, supplier: best.name, unit: best.si.unit, qty: units.toNumber(), unitPriceSatang: best.si.priceSatang, totalSatang: units.mul(best.si.priceSatang).toNumber() };
      }
      out.push({
        ingredientId: ing.id,
        name: ing.name,
        baseUnit: ing.baseUnit,
        onHand: onHand.toFixed(2),
        reorderPoint: ing.reorderPoint,
        avgDailyUsage: daily.toFixed(2),
        daysOfCover: coverDays ? coverDays.toFixed(1) : null,
        needBase: needBase.toFixed(2),
        basis: daily.gt(0) ? 'USAGE_14D' : 'REORDER_POINT',
        suggestion,
      });
    }
    return { items: out };
  });
}
