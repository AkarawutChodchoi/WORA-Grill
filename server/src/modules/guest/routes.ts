import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { dateString, nonEmpty, satang, uuid } from '@shared/validation';
import { customers, diningTables, orderItems, orders, reservations, serviceRequests, waitlistEntries } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAnyPerm, requireAuth, requireBranch, requirePerm } from '../../lib/auth';
import { randomToken } from '../../lib/crypto';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../../lib/errors';
import { pickLanAddress, resolvePublicBaseUrl } from '../../lib/public-url';
import { businessDate, localRange } from '../../lib/time';
import { branchSettings } from '../menu/service';
import { orderHooks, runItemsHook } from '../orders/hooks';
import { getOrderDetail, lockOrder, recalcOrder, sendItems } from '../orders/service';
import { openTable, refreshTableForOrder } from '../tables/service';
import { assertReservable, averageWaitMinutes, issueQrSession, revokeQrForOrder } from './service';

let hooksRegistered = false;
function registerGuestHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  // A bill that is paid or voided ends its QR session.
  orderHooks.orderPaid.push(async (ctx, o) => revokeQrForOrder(ctx.db, o.id));
  orderHooks.orderVoided.push(async (ctx, o) => revokeQrForOrder(ctx.db, o.id));
}

const phone = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => /^0\d{8,9}$/.test(v), 'เบอร์โทรไม่ถูกต้อง');

export const reservationBody = z.object({
  name: nonEmpty(100),
  phone,
  partySize: z.number().int().min(1).max(100),
  reservedAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(15).max(600).optional(),
  zoneId: uuid.nullable().optional(),
  tableId: uuid.nullable().optional(),
  channel: z.enum(['PHONE', 'WALK_IN', 'LINE', 'WEB']).default('PHONE'),
  depositSatang: satang.default(0),
  depositStatus: z.enum(['NONE', 'PENDING', 'PAID', 'REFUNDED', 'FORFEITED']).default('NONE'),
  notes: z.string().trim().max(500).nullable().optional(),
  customerId: uuid.nullable().optional(),
});

const NEXT: Record<string, string[]> = {
  BOOKED: ['CONFIRMED', 'CANCELLED', 'NO_SHOW', 'SEATED'],
  CONFIRMED: ['CANCELLED', 'NO_SHOW', 'SEATED'],
  SEATED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export default async function guestRoutes(app: FastifyInstance) {
  const { db, bus, config } = app.deps;
  /** Base URL for guest links, as seen from the staff device that asked (see lib/public-url). */
  const baseUrl = (req: FastifyRequest) => {
    const h = req.headers;
    const referer = typeof h.referer === 'string' ? h.referer : undefined;
    return resolvePublicBaseUrl({
      configured: config.PUBLIC_BASE_URL,
      origin: typeof h.origin === 'string' ? h.origin : referer,
      host: typeof h['x-forwarded-host'] === 'string' ? h['x-forwarded-host'] : h.host,
      protocol: req.protocol,
      lanAddress: pickLanAddress(),
    });
  };
  registerGuestHooks();
  const emitRes = (orgId: string, branchId: string) => bus.publish({ type: 'reservation.updated', organizationId: orgId, branchId, payload: {} });
  const emitQueue = (orgId: string, branchId: string) => bus.publish({ type: 'waitlist.updated', organizationId: orgId, branchId, payload: {} });

  // ---------- Reservations ----------
  app.get('/reservations', async (req) => {
    const a = requireAnyPerm(req, 'reservation.manage', 'table.view');
    const branchId = requireBranch(a);
    const { date } = parse(z.object({ date: dateString }), req.query);
    const s = await branchSettings(db, branchId);
    const [from, to] = localRange(date, date, s.timezone);
    const rows = await db
      .select({ r: reservations, tableName: diningTables.name })
      .from(reservations)
      .leftJoin(diningTables, eq(diningTables.id, reservations.tableId))
      .where(and(eq(reservations.branchId, branchId), sql`${reservations.reservedAt} >= ${from.toISOString()}::timestamptz and ${reservations.reservedAt} < ${to.toISOString()}::timestamptz`))
      .orderBy(asc(reservations.reservedAt));
    return { reservations: rows.map((x) => ({ ...x.r, tableName: x.tableName })), defaultDuration: s.reservationSeatingMinutes };
  });

  app.post('/reservations', async (req) => {
    const a = requirePerm(req, 'reservation.manage');
    const branchId = requireBranch(a);
    const body = parse(reservationBody, req.body);
    const s = await branchSettings(db, branchId);
    const reservedAt = new Date(body.reservedAt);
    if (reservedAt.getTime() < Date.now() - 15 * 60_000) throw badRequest('เวลาจองต้องไม่อยู่ในอดีต');
    const duration = body.durationMinutes ?? s.reservationSeatingMinutes;
    if (body.customerId) {
      const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, body.customerId), eq(customers.organizationId, a.orgId)));
      if (!c) throw badRequest('ลูกค้าไม่ถูกต้อง');
    }
    const r = await db.transaction(async (tx) => {
      // Serialise bookings of one branch so two staff cannot double-book the same slot.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'res:' + branchId}))`);
      await assertReservable(tx, { branchId, reservedAt, durationMinutes: duration, partySize: body.partySize, tableId: body.tableId, zoneId: body.zoneId });
      const [r] = await tx
        .insert(reservations)
        .values({ ...body, organizationId: a.orgId, branchId, reservedAt, durationMinutes: duration, zoneId: body.zoneId ?? null, tableId: body.tableId ?? null, customerId: body.customerId ?? null, createdBy: a.userId })
        .returning();
      await audit(tx, a, { action: 'reservation.create', targetType: 'reservation', targetId: r.id, data: { partySize: r.partySize, reservedAt: r.reservedAt } }, req.ip);
      return r;
    });
    emitRes(a.orgId, branchId);
    return r;
  });

  app.patch('/reservations/:id', async (req) => {
    const a = requirePerm(req, 'reservation.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(reservationBody.partial(), req.body);
    if (body.customerId) {
      const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, body.customerId), eq(customers.organizationId, a.orgId)));
      if (!c) throw badRequest('ลูกค้าไม่ถูกต้อง');
    }
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'res:' + branchId}))`);
      const [cur] = await tx.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.branchId, branchId)));
      if (!cur) throw notFound('การจอง');
      if (!['BOOKED', 'CONFIRMED'].includes(cur.status)) throw conflict('แก้ไขได้เฉพาะการจองที่ยังไม่มาถึง');
      const next = { ...cur, ...body, reservedAt: body.reservedAt ? new Date(body.reservedAt) : cur.reservedAt };
      await assertReservable(tx, { branchId, reservedAt: next.reservedAt, durationMinutes: next.durationMinutes, partySize: next.partySize, tableId: next.tableId, zoneId: next.zoneId, excludeId: id });
      const [r] = await tx
        .update(reservations)
        .set({ ...body, reservedAt: next.reservedAt })
        .where(eq(reservations.id, id))
        .returning();
      await audit(tx, a, { action: 'reservation.update', targetType: 'reservation', targetId: id, data: body }, req.ip);
      return r;
    });
    emitRes(a.orgId, branchId);
    return r;
  });

  app.post('/reservations/:id/status', async (req) => {
    const a = requirePerm(req, 'reservation.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ status: z.enum(['CONFIRMED', 'CANCELLED', 'NO_SHOW', 'COMPLETED']), reason: z.string().max(300).optional(), depositStatus: z.enum(['NONE', 'PENDING', 'PAID', 'REFUNDED', 'FORFEITED']).optional() }), req.body);
    const [cur] = await db.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.branchId, branchId)));
    if (!cur) throw notFound('การจอง');
    if (!NEXT[cur.status].includes(body.status)) throw conflict(`เปลี่ยนสถานะจาก ${cur.status} เป็น ${body.status} ไม่ได้`, 'INVALID_STATE');
    if (body.status === 'CANCELLED' && !body.reason) throw badRequest('ระบุเหตุผลการยกเลิก');
    // No-show: deposit is forfeited per policy unless staff explicitly choose otherwise.
    const depositStatus = body.depositStatus ?? (body.status === 'NO_SHOW' && cur.depositStatus === 'PAID' ? 'FORFEITED' : cur.depositStatus);
    await db.update(reservations).set({ status: body.status, cancelledReason: body.reason ?? cur.cancelledReason, depositStatus }).where(eq(reservations.id, id));
    await audit(db, a, { action: `reservation.${body.status.toLowerCase()}`, targetType: 'reservation', targetId: id, reason: body.reason, data: { depositStatus } }, req.ip);
    emitRes(a.orgId, branchId);
    return { ok: true };
  });

  /** Guest arrived: open the (assigned or chosen) table for the party. */
  app.post('/reservations/:id/seat', async (req) => {
    const a = requirePerm(req, 'reservation.manage', 'table.operate', 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ tableId: uuid.optional(), guestCount: z.number().int().min(1).max(100).optional() }), req.body);
    const order = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.branchId, branchId))).for('update');
      if (!r) throw notFound('การจอง');
      if (!['BOOKED', 'CONFIRMED'].includes(r.status)) throw conflict('การจองนี้ไม่อยู่ในสถานะรอเข้านั่ง');
      const tableId = body.tableId ?? r.tableId;
      if (!tableId) throw badRequest('เลือกโต๊ะที่จะให้นั่ง');
      const { order } = await openTable(tx, { orgId: a.orgId, branchId, tableId, guestCount: body.guestCount ?? r.partySize, note: r.notes ? `จอง: ${r.notes}` : `จอง: ${r.name}`, openedBy: a.userId, source: 'POS', customerId: r.customerId });
      await tx.update(reservations).set({ status: 'SEATED', tableId, orderId: order.id }).where(eq(reservations.id, id));
      await audit(tx, a, { action: 'reservation.seated', targetType: 'reservation', targetId: id, data: { orderId: order.id, tableId } }, req.ip);
      return order;
    });
    bus.publish({ type: 'table.status_changed', organizationId: a.orgId, branchId, payload: { tableId: order.tableId, status: 'OCCUPIED' } });
    emitRes(a.orgId, branchId);
    return order;
  });

  // ---------- Walk-in queue ----------
  app.get('/waitlist', async (req) => {
    const a = requireAnyPerm(req, 'reservation.manage', 'table.view');
    const branchId = requireBranch(a);
    const s = await branchSettings(db, branchId);
    const list = await db
      .select()
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.branchId, branchId), eq(waitlistEntries.businessDate, businessDate(s.timezone))))
      .orderBy(asc(waitlistEntries.queueNo));
    return { entries: list.map((e) => ({ ...e, publicUrl: `${baseUrl(req)}/q/${e.publicToken}` })), avgWaitMinutes: await averageWaitMinutes(db, branchId) };
  });

  app.post('/waitlist', async (req) => {
    const a = requirePerm(req, 'reservation.manage');
    const branchId = requireBranch(a);
    const body = parse(z.object({ name: nonEmpty(60), phone: phone.optional(), partySize: z.number().int().min(1).max(100) }), req.body);
    const s = await branchSettings(db, branchId);
    const bd = businessDate(s.timezone);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const e = await db.transaction(async (tx) => {
          const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${waitlistEntries.queueNo}), 0)::int + 1` }).from(waitlistEntries).where(and(eq(waitlistEntries.branchId, branchId), eq(waitlistEntries.businessDate, bd)));
          const [e] = await tx
            .insert(waitlistEntries)
            .values({ organizationId: a.orgId, branchId, businessDate: bd, queueNo: next, name: body.name, phone: body.phone ?? null, partySize: body.partySize, publicToken: randomToken(18), createdBy: a.userId })
            .returning();
          return e;
        });
        emitQueue(a.orgId, branchId);
        return { ...e, publicUrl: `${baseUrl(req)}/q/${e.publicToken}`, qrDataUrl: await QRCode.toDataURL(`${baseUrl(req)}/q/${e.publicToken}`, { margin: 1, width: 220 }) };
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e; // concurrent ticket: retry with the next number
      }
    }
    throw conflict('ออกบัตรคิวไม่สำเร็จ ลองใหม่');
  });

  app.post('/waitlist/:id/:action', async (req) => {
    const a = requirePerm(req, 'reservation.manage');
    const branchId = requireBranch(a);
    const { id, action } = parse(z.object({ id: uuid, action: z.enum(['call', 'seat', 'left']) }), req.params);
    const body = parse(z.object({ tableId: uuid.optional() }), req.body ?? {});
    const out = await db.transaction(async (tx) => {
      const [e] = await tx.select().from(waitlistEntries).where(and(eq(waitlistEntries.id, id), eq(waitlistEntries.branchId, branchId))).for('update');
      if (!e) throw notFound('คิว');
      if (['SEATED', 'LEFT'].includes(e.status)) throw conflict('คิวนี้จบแล้ว');
      if (action === 'call') {
        await tx.update(waitlistEntries).set({ status: 'CALLED', calledAt: new Date() }).where(eq(waitlistEntries.id, id));
        return { entry: e };
      }
      if (action === 'left') {
        await tx.update(waitlistEntries).set({ status: 'LEFT', leftAt: new Date() }).where(eq(waitlistEntries.id, id));
        return { entry: e };
      }
      if (!body.tableId) throw badRequest('เลือกโต๊ะ');
      if (!a.permissions.has('table.operate') || !a.permissions.has('order.create')) throw badRequest('ต้องมีสิทธิ์เปิดโต๊ะ');
      const { order } = await openTable(tx, { orgId: a.orgId, branchId, tableId: body.tableId, guestCount: e.partySize, note: `คิว ${e.queueNo} ${e.name}`, openedBy: a.userId, source: 'POS' });
      await tx.update(waitlistEntries).set({ status: 'SEATED', seatedAt: new Date(), tableId: body.tableId }).where(eq(waitlistEntries.id, id));
      return { entry: e, order };
    });
    await audit(db, a, { action: `waitlist.${action}`, targetType: 'waitlist', targetId: id, data: { queueNo: out.entry.queueNo } }, req.ip);
    emitQueue(a.orgId, branchId);
    if (out.order) bus.publish({ type: 'table.status_changed', organizationId: a.orgId, branchId, payload: { tableId: body.tableId, status: 'OCCUPIED' } });
    return { ok: true, orderId: out.order?.id };
  });

  // ---------- Guest service requests ----------
  app.get('/service-requests', async (req) => {
    const a = requireAnyPerm(req, 'table.view', 'order.view');
    const branchId = requireBranch(a);
    const rows = await db
      .select({ r: serviceRequests, tableName: diningTables.name })
      .from(serviceRequests)
      .leftJoin(diningTables, eq(diningTables.id, serviceRequests.tableId))
      .where(and(eq(serviceRequests.branchId, branchId), inArray(serviceRequests.status, ['OPEN', 'ACKNOWLEDGED'])))
      .orderBy(asc(serviceRequests.createdAt));
    return { requests: rows.map((x) => ({ ...x.r, tableName: x.tableName })) };
  });

  app.post('/service-requests/:id/:action', async (req) => {
    const a = requirePerm(req, 'table.operate');
    const branchId = requireBranch(a);
    const { id, action } = parse(z.object({ id: uuid, action: z.enum(['ack', 'done']) }), req.params);
    const [r] = await db
      .update(serviceRequests)
      .set(action === 'ack' ? { status: 'ACKNOWLEDGED', acknowledgedBy: a.userId, acknowledgedAt: new Date() } : { status: 'DONE', doneAt: new Date() })
      .where(and(eq(serviceRequests.id, id), eq(serviceRequests.branchId, branchId)))
      .returning();
    if (!r) throw notFound('คำขอ');
    bus.publish({ type: 'service_request.updated', organizationId: a.orgId, branchId, payload: { id, status: r.status } });
    return { ok: true };
  });

  // ---------- QR ordering (staff side) ----------
  /** Where phones on the shop Wi-Fi can open this system (shown next to QR codes and in settings). */
  app.get('/qr/base-url', async (req) => {
    requireAuth(req);
    const url = baseUrl(req);
    return { baseUrl: url, lanAddress: pickLanAddress(), qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  });

  /** Issue / rotate the QR for an open bill (table or kiosk/takeaway). Returns the URL to print. */
  app.post('/orders/:id/qr', async (req) => {
    const a = requirePerm(req, 'order.create');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const s = await branchSettings(db, branchId);
    if (!s.qrOrderingEnabled) throw conflict('สาขานี้ปิดการสั่งผ่าน QR', 'QR_DISABLED');
    const r = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลปิดแล้ว');
      const q = await issueQrSession(tx, { orgId: a.orgId, branchId, orderId: id, tableId: o.tableId, createdBy: a.userId });
      await audit(tx, a, { action: 'qr.issue', targetType: 'order', targetId: id }, req.ip);
      return q;
    });
    const url = `${baseUrl(req)}/m/${r.token}`;
    return { url, expiresAt: r.expiresAt, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 280 }) };
  });

  /** Bills with guest-ordered lines waiting for approval. */
  app.get('/qr/pending', async (req) => {
    const a = requirePerm(req, 'order.approve_qr');
    const branchId = requireBranch(a);
    const rows = await db
      .select({ orderId: orders.id, orderNo: orders.orderNo, tableName: diningTables.name, n: sql<number>`count(${orderItems.id})::int` })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(eq(orderItems.branchId, branchId), eq(orderItems.awaitingApproval, true), eq(orderItems.status, 'PENDING')))
      .groupBy(orders.id, orders.orderNo, diningTables.name);
    return { orders: rows };
  });

  app.post('/orders/:id/approve-qr', async (req) => {
    const a = requirePerm(req, 'order.approve_qr');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ itemIds: z.array(uuid).max(100).optional(), reject: z.boolean().default(false) }), req.body ?? {});
    const sent = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, a.orgId, branchId, id);
      const waiting = await tx
        .select()
        .from(orderItems)
        .where(and(eq(orderItems.orderId, id), eq(orderItems.awaitingApproval, true), eq(orderItems.status, 'PENDING'), body.itemIds ? inArray(orderItems.id, body.itemIds) : undefined));
      if (!waiting.length) return [];
      const ids = waiting.map((w) => w.id);
      if (body.reject) {
        await tx.update(orderItems).set({ status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'พนักงานไม่อนุมัติออเดอร์ QR', cancelledBy: a.userId, awaitingApproval: false }).where(inArray(orderItems.id, ids));
        await recalcOrder(tx, id);
        await audit(tx, a, { action: 'qr.reject', targetType: 'order', targetId: id, data: { items: ids.length } }, req.ip);
        return [];
      }
      await tx.update(orderItems).set({ awaitingApproval: false }).where(inArray(orderItems.id, ids));
      const s = await sendItems(tx, bus, o, { itemIds: ids });
      await runItemsHook(orderHooks.itemsSent, { db: tx, actor: a, bus }, o, s);
      await refreshTableForOrder(tx, bus, id);
      await audit(tx, a, { action: 'qr.approve', targetType: 'order', targetId: id, data: { items: ids.length } }, req.ip);
      return s;
    });
    bus.publish({ type: 'order.updated', organizationId: a.orgId, branchId, payload: { orderId: id } });
    return { sent: sent.length, order: await getOrderDetail(db, a.orgId, branchId, id) };
  });

}
