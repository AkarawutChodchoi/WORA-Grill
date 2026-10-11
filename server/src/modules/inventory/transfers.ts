import Decimal from 'decimal.js';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decimalString, uuid } from '@shared/validation';
import { branches, ingredients, stockTransferLines, stockTransfers } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAnyPerm, requireBranch, requirePerm } from '../../lib/auth';
import { badRequest, conflict, notFound, parse } from '../../lib/errors';
import { nextDocNo } from '../payments/service';
import { D, defaultWarehouse, postMovement, toBase } from './ledger';

const positive = decimalString.refine((v) => new Decimal(v).gt(0), 'ต้องมากกว่า 0');

/**
 * Inter-branch stock transfers and central-kitchen supply (SPEC §3.16):
 * REQUESTED (by the receiving branch) → SHIPPED (stock leaves the sender: TRANSFER_OUT)
 * → RECEIVED (stock enters the receiver at the shipped cost: TRANSFER_IN; shortages recorded with a reason).
 */
export default async function transferRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;

  const load = async (orgId: string, id: string) => {
    const [t] = await db.select().from(stockTransfers).where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, orgId)));
    if (!t) throw notFound('ใบโอน');
    return t;
  };

  app.get('/transfers', async (req) => {
    const a = requireAnyPerm(req, 'inventory.view', 'stock.receive', 'stock.issue');
    const branchId = requireBranch(a);
    const list = await db
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.organizationId, a.orgId), or(eq(stockTransfers.fromBranchId, branchId), eq(stockTransfers.toBranchId, branchId))))
      .orderBy(desc(stockTransfers.createdAt))
      .limit(200);
    const lines = list.length ? await db.select({ l: stockTransferLines, name: ingredients.name, baseUnit: ingredients.baseUnit }).from(stockTransferLines).innerJoin(ingredients, eq(ingredients.id, stockTransferLines.ingredientId)).where(inArray(stockTransferLines.transferId, list.map((t) => t.id))) : [];
    const bs = await db.select({ id: branches.id, name: branches.name, isCentralKitchen: branches.isCentralKitchen }).from(branches).where(eq(branches.organizationId, a.orgId));
    return {
      transfers: list.map((t) => ({
        ...t,
        fromBranch: bs.find((b) => b.id === t.fromBranchId)?.name,
        toBranch: bs.find((b) => b.id === t.toBranchId)?.name,
        direction: t.fromBranchId === branchId ? 'OUT' : 'IN',
        lines: lines.filter((l) => l.l.transferId === t.id).map((l) => ({ ...l.l, name: l.name, baseUnit: l.baseUnit })),
      })),
      branches: bs.filter((b) => b.id !== branchId),
    };
  });

  app.post('/transfers', async (req) => {
    const a = requireAnyPerm(req, 'stock.issue', 'stock.receive');
    const branchId = requireBranch(a);
    const body = parse(
      z.object({ mode: z.enum(['SHIP', 'REQUEST']), otherBranchId: uuid, note: z.string().max(300).optional(), lines: z.array(z.object({ ingredientId: uuid, qty: positive, unit: z.string().min(1).max(20) })).min(1).max(100) }),
      req.body,
    );
    if (body.otherBranchId === branchId) throw badRequest('เลือกสาขาอื่น');
    if (new Set(body.lines.map((l) => l.ingredientId)).size !== body.lines.length) throw badRequest('มีวัตถุดิบซ้ำในใบโอน รวมเป็นบรรทัดเดียว');
    const [other] = await db.select().from(branches).where(and(eq(branches.id, body.otherBranchId), eq(branches.organizationId, a.orgId), isNull(branches.archivedAt)));
    if (!other) throw notFound('สาขาปลายทาง');
    if (body.mode === 'SHIP' && !a.permissions.has('stock.issue')) throw badRequest('ต้องมีสิทธิ์เบิก/โอนของ');
    if (body.mode === 'REQUEST' && !a.permissions.has('stock.receive')) throw badRequest('ต้องมีสิทธิ์รับของ');
    const t = await db.transaction(async (tx) => {
      const [code] = await tx.select({ code: branches.code }).from(branches).where(eq(branches.id, branchId));
      const year = String(new Date().getFullYear());
      const transferNo = `TR${code.code}${year}-${String(await nextDocNo(tx, branchId, 'TRANSFER', year)).padStart(5, '0')}`;
      const fromBranchId = body.mode === 'SHIP' ? branchId : other.id;
      const toBranchId = body.mode === 'SHIP' ? other.id : branchId;
      const [t] = await tx
        .insert(stockTransfers)
        .values({ organizationId: a.orgId, transferNo, fromBranchId, toBranchId, status: body.mode === 'SHIP' ? 'SHIPPED' : 'REQUESTED', note: body.note ?? null, requestedBy: a.userId })
        .returning();
      const fromWh = body.mode === 'SHIP' ? await defaultWarehouse(tx, a.orgId, fromBranchId) : null;
      for (const l of body.lines) {
        const [ing] = await tx.select({ id: ingredients.id }).from(ingredients).where(and(eq(ingredients.id, l.ingredientId), eq(ingredients.organizationId, a.orgId)));
        if (!ing) throw badRequest('วัตถุดิบไม่ถูกต้อง');
        const base = await toBase(tx, l.ingredientId, l.qty, l.unit);
        let unitCost: string | null = null;
        if (fromWh) {
          const out = await postMovement(tx, { orgId: a.orgId, branchId: fromBranchId, warehouseId: fromWh, ingredientId: l.ingredientId, type: 'TRANSFER_OUT', qty: base.neg(), refType: 'stock_transfer', refId: t.id, reason: `${transferNo} → ${other.name}`, idempotencyKey: `TRO:${t.id}:${l.ingredientId}`, createdBy: a.userId });
          unitCost = out!.unitCost.toFixed(6);
        }
        await tx.insert(stockTransferLines).values({ transferId: t.id, ingredientId: l.ingredientId, requestedQtyBase: base.toFixed(4), shippedQtyBase: fromWh ? base.toFixed(4) : null, unitCost });
      }
      if (fromWh) await tx.update(stockTransfers).set({ fromWarehouseId: fromWh, shippedBy: a.userId, shippedAt: new Date() }).where(eq(stockTransfers.id, t.id));
      await audit(tx, a, { action: body.mode === 'SHIP' ? 'transfer.ship' : 'transfer.request', targetType: 'stock_transfer', targetId: t.id, data: { transferNo, to: toBranchId, from: fromBranchId, lines: body.lines } }, req.ip);
      return t;
    });
    bus.publish({ type: 'notification', organizationId: a.orgId, branchId: other.id, payload: { kind: 'transfer', transferId: t.id } });
    return t;
  });

  /** Sender ships a requested transfer (may ship less than requested). */
  app.post('/transfers/:id/ship', async (req) => {
    const a = requirePerm(req, 'stock.issue');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ lines: z.array(z.object({ lineId: uuid, shippedQtyBase: decimalString })).max(100).optional() }), req.body ?? {});
    await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, a.orgId))).for('update');
      if (!t) throw notFound('ใบโอน');
      if (t.fromBranchId !== branchId) throw notFound('ใบโอน');
      if (t.status !== 'REQUESTED') throw conflict('ใบโอนนี้ส่งแล้วหรือยกเลิกแล้ว');
      const wh = await defaultWarehouse(tx, a.orgId, branchId);
      const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, id));
      for (const l of lines) {
        const qty = D(body.lines?.find((x) => x.lineId === l.id)?.shippedQtyBase ?? l.requestedQtyBase);
        if (qty.isNegative()) throw badRequest('จำนวนติดลบ');
        let unitCost = null;
        if (qty.gt(0)) {
          const out = await postMovement(tx, { orgId: a.orgId, branchId, warehouseId: wh, ingredientId: l.ingredientId, type: 'TRANSFER_OUT', qty: qty.neg(), refType: 'stock_transfer', refId: id, reason: t.transferNo, idempotencyKey: `TRO:${id}:${l.ingredientId}`, createdBy: a.userId });
          unitCost = out!.unitCost.toFixed(6);
        }
        await tx.update(stockTransferLines).set({ shippedQtyBase: qty.toFixed(4), unitCost }).where(eq(stockTransferLines.id, l.id));
      }
      await tx.update(stockTransfers).set({ status: 'SHIPPED', fromWarehouseId: wh, shippedBy: a.userId, shippedAt: new Date() }).where(eq(stockTransfers.id, id));
      await audit(tx, a, { action: 'transfer.ship', targetType: 'stock_transfer', targetId: id }, req.ip);
    });
    return { ok: true };
  });

  /** Receiver confirms what actually arrived; shortages need a reason (loss in transit). */
  app.post('/transfers/:id/receive', async (req) => {
    const a = requirePerm(req, 'stock.receive');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ lines: z.array(z.object({ lineId: uuid, receivedQtyBase: decimalString, reason: z.string().max(200).optional() })).max(100).optional() }), req.body ?? {});
    await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, a.orgId))).for('update');
      if (!t || t.toBranchId !== branchId) throw notFound('ใบโอน');
      if (t.status !== 'SHIPPED') throw conflict(t.status === 'RECEIVED' ? 'รับของใบนี้แล้ว' : 'ใบโอนนี้ยังไม่ได้ส่ง');
      const wh = await defaultWarehouse(tx, a.orgId, branchId);
      const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, id));
      for (const l of lines) {
        const shipped = D(l.shippedQtyBase ?? 0);
        const given = body.lines?.find((x) => x.lineId === l.id);
        const received = D(given?.receivedQtyBase ?? shipped);
        if (received.isNegative() || received.gt(shipped)) throw badRequest('จำนวนรับต้องไม่เกินจำนวนที่ส่ง');
        if (received.lt(shipped) && !given?.reason) throw badRequest('ระบุเหตุผลของที่ขาด/เสียระหว่างทาง');
        if (received.gt(0))
          await postMovement(tx, { orgId: a.orgId, branchId, warehouseId: wh, ingredientId: l.ingredientId, type: 'TRANSFER_IN', qty: received, unitCost: D(l.unitCost ?? 0), refType: 'stock_transfer', refId: id, reason: t.transferNo, idempotencyKey: `TRI:${id}:${l.ingredientId}`, createdBy: a.userId });
        await tx.update(stockTransferLines).set({ receivedQtyBase: received.toFixed(4), discrepancyReason: given?.reason ?? null }).where(eq(stockTransferLines.id, l.id));
      }
      await tx.update(stockTransfers).set({ status: 'RECEIVED', toWarehouseId: wh, receivedBy: a.userId, receivedAt: new Date() }).where(eq(stockTransfers.id, id));
      await audit(tx, a, { action: 'transfer.receive', targetType: 'stock_transfer', targetId: id, data: { lines: body.lines } }, req.ip);
    });
    return { ok: true };
  });

  app.post('/transfers/:id/cancel', async (req) => {
    const a = requireAnyPerm(req, 'stock.issue', 'stock.receive');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = await load(a.orgId, id);
    if (t.fromBranchId !== branchId && t.toBranchId !== branchId) throw notFound('ใบโอน');
    if (t.status !== 'REQUESTED') throw conflict('ยกเลิกได้เฉพาะคำขอที่ยังไม่ส่ง');
    await db.update(stockTransfers).set({ status: 'CANCELLED' }).where(eq(stockTransfers.id, id));
    await audit(db, a, { action: 'transfer.cancel', targetType: 'stock_transfer', targetId: id }, req.ip);
    return { ok: true };
  });
}
