import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nonEmpty, uuid } from '@shared/validation';
import { diningTables, orderItems, orders, users, zones, zoneWaiters } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireBranch, requirePerm } from '../../lib/auth';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../../lib/errors';
import { assertFree, loadTableForUpdate, openTable, releaseTable, setDerivedStatus } from './service';

const tableBody = z.object({
  zoneId: uuid,
  name: nonEmpty(20),
  capacity: z.number().int().min(1).max(50).default(4),
  shape: z.enum(['square', 'round', 'rect']).default('square'),
  posX: z.number().int().min(0).max(200).default(0),
  posY: z.number().int().min(0).max(200).default(0),
  width: z.number().int().min(1).max(10).default(2),
  height: z.number().int().min(1).max(10).default(2),
});

export default async function tableRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;
  const emit = (orgId: string, branchId: string, tableId: string, status: string) =>
    bus.publish({ type: 'table.status_changed', organizationId: orgId, branchId, payload: { tableId, status } });

  /** Floor plan with live status and active-order summary. */
  app.get('/tables', async (req) => {
    const a = requirePerm(req, 'table.view');
    const branchId = requireBranch(a);
    const [zs, ts, waiters] = await Promise.all([
      db.select().from(zones).where(and(eq(zones.branchId, branchId), isNull(zones.archivedAt))).orderBy(asc(zones.sort), asc(zones.name)),
      db.select().from(diningTables).where(and(eq(diningTables.branchId, branchId), isNull(diningTables.archivedAt))).orderBy(asc(diningTables.name)),
      db
        .select({ zoneId: zoneWaiters.zoneId, userId: zoneWaiters.userId, name: users.name })
        .from(zoneWaiters)
        .innerJoin(users, eq(users.id, zoneWaiters.userId))
        .innerJoin(zones, eq(zones.id, zoneWaiters.zoneId))
        .where(eq(zones.branchId, branchId)),
    ]);
    const orderIds = ts.map((t) => t.currentOrderId).filter((x): x is string => !!x);
    const os = orderIds.length
      ? await db
          .select({
            id: orders.id,
            orderNo: orders.orderNo,
            guestCount: orders.guestCount,
            openedAt: orders.openedAt,
            grandTotalSatang: orders.grandTotalSatang,
            status: orders.status,
            openedBy: users.name,
            readyCount: sql<number>`(select count(*)::int from ${orderItems} oi where oi.order_id = ${orders.id} and oi.status = 'READY')`,
          })
          .from(orders)
          .leftJoin(users, eq(users.id, orders.openedBy))
          .where(inArray(orders.id, orderIds))
      : [];
    return {
      zones: zs.map((z) => ({ ...z, waiters: waiters.filter((w) => w.zoneId === z.id).map((w) => ({ id: w.userId, name: w.name })) })),
      tables: ts.map((t) => ({ ...t, order: os.find((o) => o.id === t.currentOrderId) ?? null })),
    };
  });

  // ---- Zones ----
  const zoneBody = z.object({ name: nonEmpty(60), floor: z.string().trim().max(30).nullable().optional(), sort: z.number().int().min(0).max(1000).default(0) });
  app.post('/zones', async (req) => {
    const a = requirePerm(req, 'table.manage');
    const branchId = requireBranch(a);
    const body = parse(zoneBody, req.body);
    const [zn] = await db.insert(zones).values({ organizationId: a.orgId, branchId, ...body }).returning();
    await audit(db, a, { action: 'zone.create', targetType: 'zone', targetId: zn.id, data: body }, req.ip);
    return zn;
  });
  app.patch('/zones/:id', async (req) => {
    const a = requirePerm(req, 'table.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(zoneBody.partial().extend({ archived: z.boolean().optional() }), req.body);
    const { archived, ...cols } = body;
    if (archived) {
      const [busy] = await db.select({ id: diningTables.id }).from(diningTables).where(and(eq(diningTables.zoneId, id), isNull(diningTables.archivedAt))).limit(1);
      if (busy) throw conflict('ย้ายหรือเก็บโต๊ะในโซนนี้ก่อน');
    }
    const [zn] = await db
      .update(zones)
      .set({ ...cols, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
      .where(and(eq(zones.id, id), eq(zones.branchId, branchId)))
      .returning();
    if (!zn) throw notFound('โซน');
    await audit(db, a, { action: 'zone.update', targetType: 'zone', targetId: id, data: body }, req.ip);
    return zn;
  });
  app.put('/zones/:id/waiters', async (req) => {
    const a = requirePerm(req, 'table.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { userIds } = parse(z.object({ userIds: z.array(uuid).max(50) }), req.body);
    const [zn] = await db.select().from(zones).where(and(eq(zones.id, id), eq(zones.branchId, branchId)));
    if (!zn) throw notFound('โซน');
    if (userIds.length) {
      const found = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, userIds), eq(users.organizationId, a.orgId)));
      if (found.length !== new Set(userIds).size) throw badRequest('พนักงานไม่ถูกต้อง');
    }
    await db.transaction(async (tx) => {
      await tx.delete(zoneWaiters).where(eq(zoneWaiters.zoneId, id));
      if (userIds.length) await tx.insert(zoneWaiters).values([...new Set(userIds)].map((userId) => ({ zoneId: id, userId })));
      await audit(tx, a, { action: 'zone.waiters', targetType: 'zone', targetId: id, data: { userIds } }, req.ip);
    });
    return { ok: true };
  });

  // ---- Tables ----
  app.post('/tables', async (req) => {
    const a = requirePerm(req, 'table.manage');
    const branchId = requireBranch(a);
    const body = parse(tableBody, req.body);
    const [zn] = await db.select().from(zones).where(and(eq(zones.id, body.zoneId), eq(zones.branchId, branchId)));
    if (!zn) throw badRequest('โซนไม่ถูกต้อง');
    try {
      const [t] = await db.insert(diningTables).values({ organizationId: a.orgId, branchId, ...body }).returning();
      await audit(db, a, { action: 'table.create', targetType: 'table', targetId: t.id, data: body }, req.ip);
      return t;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('มีโต๊ะชื่อนี้แล้ว');
      throw e;
    }
  });

  app.patch('/tables/:id', async (req) => {
    const a = requirePerm(req, 'table.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(tableBody.partial().extend({ archived: z.boolean().optional() }), req.body);
    const { archived, ...cols } = body;
    if (cols.zoneId) {
      const [zn] = await db.select().from(zones).where(and(eq(zones.id, cols.zoneId), eq(zones.branchId, branchId)));
      if (!zn) throw badRequest('โซนไม่ถูกต้อง');
    }
    try {
      const t = await db.transaction(async (tx) => {
        const cur = await loadTableForUpdate(tx, a.orgId, branchId, id);
        if (archived && cur.currentOrderId) throw conflict('โต๊ะมีบิลเปิดอยู่ เก็บไม่ได้');
        const [t] = await tx
          .update(diningTables)
          .set({ ...cols, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
          .where(eq(diningTables.id, id))
          .returning();
        await audit(tx, a, { action: 'table.update', targetType: 'table', targetId: id, data: body }, req.ip);
        return t;
      });
      return t;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('มีโต๊ะชื่อนี้แล้ว');
      throw e;
    }
  });

  /** Save floor-plan positions after drag/arrow-key editing. */
  app.put('/tables/layout', async (req) => {
    const a = requirePerm(req, 'table.manage');
    const branchId = requireBranch(a);
    const { positions } = parse(
      z.object({ positions: z.array(z.object({ id: uuid, posX: z.number().int().min(0).max(200), posY: z.number().int().min(0).max(200) })).max(500) }),
      req.body,
    );
    await db.transaction(async (tx) => {
      for (const p of positions)
        await tx.update(diningTables).set({ posX: p.posX, posY: p.posY }).where(and(eq(diningTables.id, p.id), eq(diningTables.branchId, branchId)));
    });
    return { ok: true };
  });

  /** Seat guests: create the dine-in bill and claim the table atomically. */
  app.post('/tables/:id/open', async (req) => {
    const a = requirePerm(req, 'table.operate', 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ guestCount: z.number().int().min(1).max(100), orderId: uuid.optional(), note: z.string().max(300).optional() }), req.body);
    try {
      const result = await db.transaction(async (tx) => {
        if (body.orderId) {
          const [prev] = await tx.select().from(orders).where(and(eq(orders.id, body.orderId), eq(orders.branchId, branchId)));
          if (prev) return { order: prev, replay: true }; // idempotent retry
        }
        const { order } = await openTable(tx, { orgId: a.orgId, branchId, tableId: id, guestCount: body.guestCount, orderId: body.orderId, note: body.note, openedBy: a.userId, source: a.sessionKind === 'PIN' ? 'WAITER' : 'POS' });
        await audit(tx, a, { action: 'table.open', targetType: 'table', targetId: id, data: { orderId: order.id, orderNo: order.orderNo, guestCount: body.guestCount } }, req.ip);
        return { order, replay: false };
      });
      if (!result.replay) {
        emit(a.orgId, branchId, id, 'OCCUPIED');
        bus.publish({ type: 'order.created', organizationId: a.orgId, branchId, payload: { orderId: result.order.id, tableId: id } });
      }
      return result.order;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('โต๊ะนี้ถูกเปิดโดยเครื่องอื่นแล้ว', 'TABLE_OCCUPIED');
      throw e;
    }
  });

  /** Move the active bill to another free table. */
  app.post('/tables/:id/move', async (req) => {
    const a = requirePerm(req, 'table.operate');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { toTableId } = parse(z.object({ toTableId: uuid }), req.body);
    if (toTableId === id) throw badRequest('เลือกโต๊ะปลายทางอื่น');
    const out = await db.transaction(async (tx) => {
      // Lock in a stable order to avoid deadlocks between opposite moves.
      const [first, second] = [id, toTableId].sort();
      const t1 = await loadTableForUpdate(tx, a.orgId, branchId, first);
      const t2 = await loadTableForUpdate(tx, a.orgId, branchId, second);
      const from = t1.id === id ? t1 : t2;
      const to = t1.id === id ? t2 : t1;
      if (!from.currentOrderId) throw conflict(`โต๊ะ ${from.name} ไม่มีบิลเปิดอยู่`);
      if (from.mergedIntoTableId) throw conflict('ย้ายจากโต๊ะหลักของกลุ่มเท่านั้น');
      assertFree(to);
      const orderId = from.currentOrderId;
      await tx.update(orders).set({ tableId: to.id, version: sql`${orders.version} + 1` }).where(eq(orders.id, orderId));
      await tx
        .update(diningTables)
        .set({ currentOrderId: orderId, status: from.status, statusChangedAt: new Date(), version: sql`${diningTables.version} + 1` })
        .where(eq(diningTables.id, to.id));
      // Joined tables follow the bill.
      await tx.update(diningTables).set({ mergedIntoTableId: to.id }).where(eq(diningTables.mergedIntoTableId, from.id));
      await tx
        .update(diningTables)
        .set({ currentOrderId: null, status: 'CLEANING', statusChangedAt: new Date(), version: sql`${diningTables.version} + 1` })
        .where(eq(diningTables.id, from.id));
      await audit(tx, a, { action: 'table.move', targetType: 'order', targetId: orderId, data: { from: from.name, to: to.name } }, req.ip);
      return { from, to, orderId };
    });
    emit(a.orgId, branchId, out.from.id, 'CLEANING');
    emit(a.orgId, branchId, out.to.id, out.from.status);
    bus.publish({ type: 'order.updated', organizationId: a.orgId, branchId, payload: { orderId: out.orderId } });
    return { ok: true };
  });

  /** Join free tables to an occupied primary table for a large party (one bill). */
  app.post('/tables/:id/join', async (req) => {
    const a = requirePerm(req, 'table.operate');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { tableIds } = parse(z.object({ tableIds: z.array(uuid).min(1).max(10) }), req.body);
    if (tableIds.includes(id)) throw badRequest('เลือกโต๊ะอื่นเพื่อรวม');
    await db.transaction(async (tx) => {
      const ids = [id, ...tableIds].sort();
      const locked = [];
      for (const tid of ids) locked.push(await loadTableForUpdate(tx, a.orgId, branchId, tid));
      const primary = locked.find((t) => t.id === id)!;
      if (!primary.currentOrderId) throw conflict('เปิดโต๊ะหลักก่อนรวมโต๊ะ');
      for (const t of locked.filter((x) => x.id !== id)) {
        assertFree(t);
        await tx
          .update(diningTables)
          .set({ mergedIntoTableId: id, status: primary.status, statusChangedAt: new Date(), version: sql`${diningTables.version} + 1` })
          .where(eq(diningTables.id, t.id));
      }
      await audit(tx, a, { action: 'table.join', targetType: 'table', targetId: id, data: { tableIds } }, req.ip);
    });
    for (const t of tableIds) emit(a.orgId, branchId, t, 'OCCUPIED');
    return { ok: true };
  });

  /** Release joined tables (split a group seating). */
  app.post('/tables/:id/unjoin', async (req) => {
    const a = requirePerm(req, 'table.operate');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { tableIds } = parse(z.object({ tableIds: z.array(uuid).min(1).max(10) }), req.body);
    const released = await db.transaction(async (tx) => {
      await loadTableForUpdate(tx, a.orgId, branchId, id);
      const rows = await tx
        .update(diningTables)
        .set({ mergedIntoTableId: null, status: 'AVAILABLE', statusChangedAt: new Date(), version: sql`${diningTables.version} + 1` })
        .where(and(inArray(diningTables.id, tableIds), eq(diningTables.mergedIntoTableId, id)))
        .returning({ id: diningTables.id });
      await audit(tx, a, { action: 'table.unjoin', targetType: 'table', targetId: id, data: { tableIds: rows.map((r) => r.id) } }, req.ip);
      return rows;
    });
    for (const r of released) emit(a.orgId, branchId, r.id, 'AVAILABLE');
    return { released: released.length };
  });

  /** Manual status: mark a free table as cleaned (CLEANING → AVAILABLE) or needing cleaning. */
  app.post('/tables/:id/status', async (req) => {
    const a = requirePerm(req, 'table.operate');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { status, version } = parse(z.object({ status: z.enum(['AVAILABLE', 'CLEANING']), version: z.number().int().optional() }), req.body);
    await db.transaction(async (tx) => {
      const t = await loadTableForUpdate(tx, a.orgId, branchId, id);
      if (version !== undefined && version !== t.version) throw conflict('สถานะโต๊ะถูกเปลี่ยนโดยเครื่องอื่น กรุณารีเฟรช', 'STALE');
      if (t.currentOrderId || t.mergedIntoTableId) throw conflict('โต๊ะมีลูกค้าอยู่ เปลี่ยนสถานะด้วยมือไม่ได้');
      await tx.update(diningTables).set({ status, statusChangedAt: new Date(), version: sql`${diningTables.version} + 1` }).where(eq(diningTables.id, id));
      await audit(tx, a, { action: 'table.status', targetType: 'table', targetId: id, data: { from: t.status, to: status } }, req.ip);
    });
    emit(a.orgId, branchId, id, status);
    return { ok: true };
  });

  /** Recompute (repair) a table's status from its order — safe to call any time. */
  app.post('/tables/:id/refresh', async (req) => {
    const a = requirePerm(req, 'table.view');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const status = await db.transaction(async (tx) => {
      const t = await loadTableForUpdate(tx, a.orgId, branchId, id);
      if (t.currentOrderId) {
        const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, t.currentOrderId));
        if (!o || !['OPEN', 'BILL_REQUESTED'].includes(o.status)) {
          await releaseTable(tx, bus, id);
          return 'CLEANING';
        }
      }
      return setDerivedStatus(tx, bus, t);
    });
    return { status };
  });
}
