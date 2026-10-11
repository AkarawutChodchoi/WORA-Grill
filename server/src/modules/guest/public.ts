import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { promptPayPayload } from '@shared/promptpay';
import { uuid } from '@shared/validation';
import { branches, orderItems, reservations, serviceRequests, waitlistEntries } from '../../db/schema';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound, parse, tooMany, unprocessable } from '../../lib/errors';
import { RateLimiter } from '../../lib/rate-limit';
import { branchSettings, loadBranchMenu, resolveLine } from '../menu/service';
import { orderHooks, runItemsHook } from '../orders/hooks';
import { lockOrder, nextSeq, recalcOrder, sendItems } from '../orders/service';
import { paidAmount } from '../payments/service';
import { refreshTableForOrder } from '../tables/service';
import { reservationBody } from './routes';
import { assertReservable, averageWaitMinutes, loadQrSession } from './service';

const ipLimiter = new RateLimiter(240, 60_000);
const submitLimiter = new RateLimiter(12, 5 * 60_000);
const requestLimiter = new RateLimiter(6, 5 * 60_000);
const bookingLimiter = new RateLimiter(5, 60 * 60_000);

const REQUEST_LABEL: Record<string, string> = { CALL_WAITER: 'เรียกพนักงาน', WATER: 'ขอน้ำ', ICE: 'ขอน้ำแข็ง', BILL: 'เรียกเช็กบิล', OTHER: 'คำขอ' };

/**
 * Public, unauthenticated endpoints for guests: QR menu/ordering, queue status and web booking.
 * They only ever expose data scoped to the presented token and never staff or other customers' data.
 */
export default async function publicRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;
  const guard = (req: FastifyRequest) => {
    if (!ipLimiter.take(`ip:${req.ip}`)) throw tooMany();
  };
  const session = async (req: FastifyRequest) => {
    guard(req);
    const { token } = parse(z.object({ token: z.string().max(80) }), req.params);
    const s = await loadQrSession(db, token);
    if (!s) throw notFound('QR นี้หมดอายุหรือถูกยกเลิกแล้ว กรุณาติดต่อพนักงาน');
    return { ...s, token };
  };

  const guestOrderView = async (orderId: string) => {
    const items = await db
      .select({ id: orderItems.id, name: orderItems.nameSnapshot, nameEn: orderItems.nameEnSnapshot, qty: orderItems.qty, status: orderItems.status, unitPriceSatang: orderItems.unitPriceSatang, modifiers: orderItems.modifiers, note: orderItems.note, awaitingApproval: orderItems.awaitingApproval, source: orderItems.source })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.seq));
    return items.map((i) => ({ ...i, modifiers: i.modifiers.map((m) => ({ name: m.name, qty: m.qty })) }));
  };

  app.get('/public/qr/:token', async (req) => {
    const s = await session(req);
    const settings = await branchSettings(db, s.order.branchId);
    const [b] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, s.order.branchId));
    const menu = await loadBranchMenu(db, { orgId: s.order.organizationId, branchId: s.order.branchId, channel: s.order.channel });
    const { confirmed, pending } = await paidAmount(db, s.order.id);
    return {
      branchName: b.name,
      tableName: s.tableName,
      orderNo: s.order.orderNo,
      orderOpen: s.orderOpen,
      orderingEnabled: settings.qrOrderingEnabled && s.order.status === 'OPEN',
      requiresApproval: settings.qrRequireApproval,
      expiresAt: s.session.expiresAt,
      menu: { categories: menu.categories, items: menu.items.filter((i) => !i.hideOnQr).map(({ sku: _s, barcode: _b, ...rest }) => rest) },
      order: { items: await guestOrderView(s.order.id), subtotalSatang: s.order.subtotalSatang, serviceChargeSatang: s.order.serviceChargeSatang, vatSatang: s.order.vatSatang, discountSatang: s.order.discountSatang, grandTotalSatang: s.order.grandTotalSatang, dueSatang: s.order.grandTotalSatang - confirmed - pending, status: s.order.status },
      payment: { promptPay: settings.enabledPaymentMethods.includes('PROMPTPAY') && !!settings.promptPayId },
    };
  });

  /** Guest places items from the table. Server re-validates every price, modifier and availability. */
  app.post('/public/qr/:token/items', async (req) => {
    const s = await session(req);
    if (!submitLimiter.take(`qr:${s.session.id}`)) throw tooMany('ส่งออเดอร์บ่อยเกินไป กรุณารอสักครู่');
    const body = parse(
      z.object({
        items: z
          .array(z.object({ id: uuid, menuItemId: uuid, qty: z.number().int().min(1).max(20), modifiers: z.array(z.object({ modifierId: uuid, qty: z.number().int().min(1).max(10).optional() })).max(20).default([]), note: z.string().trim().max(150).optional() }))
          .min(1)
          .max(30),
      }),
      req.body,
    );
    const settings = await branchSettings(db, s.order.branchId);
    if (!settings.qrOrderingEnabled) throw conflict('ร้านปิดการสั่งผ่าน QR ชั่วคราว', 'QR_DISABLED');
    // Guest actions are recorded without a staff actor.
    const actor = { orgId: s.order.organizationId, branchId: s.order.branchId, userId: null as unknown as string };
    const result = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, s.order.organizationId, s.order.branchId, s.order.id);
      if (o.status !== 'OPEN') throw conflict('บิลนี้เรียกเช็กบิลหรือปิดแล้ว กรุณาติดต่อพนักงาน', 'ORDER_NOT_EDITABLE');
      const existing = await tx.select({ id: orderItems.id, orderId: orderItems.orderId }).from(orderItems).where(inArray(orderItems.id, body.items.map((i) => i.id)));
      if (existing.some((e) => e.orderId !== o.id)) throw conflict('รหัสรายการไม่ถูกต้อง');
      const fresh = body.items.filter((i) => !existing.some((e) => e.id === i.id));
      if (!fresh.length) return { added: 0, sent: 0 };
      const menu = await loadBranchMenu(tx, { orgId: o.organizationId, branchId: o.branchId, channel: o.channel });
      let seq = await nextSeq(tx, o.id);
      const rows = fresh.map((l) => {
        const item = menu.items.find((m) => m.id === l.menuItemId);
        if (!item || item.hideOnQr) throw unprocessable('มีเมนูที่ไม่สามารถสั่งผ่าน QR ได้', 'ITEM_UNAVAILABLE');
        const r = resolveLine(menu, l);
        return {
          id: l.id,
          orderId: o.id,
          organizationId: o.organizationId,
          branchId: o.branchId,
          menuItemId: r.menuItemId,
          nameSnapshot: r.name,
          nameEnSnapshot: r.nameEn,
          basePriceSatang: r.basePriceSatang,
          unitPriceSatang: r.unitPriceSatang,
          qty: l.qty,
          modifiers: r.modifiers.map((m) => ({ modifierId: m.modifierId, groupName: m.groupName, name: m.name, qty: m.qty, priceDeltaSatang: m.priceDeltaSatang })),
          comboComponents: r.comboComponents,
          allergens: r.allergens,
          note: l.note || null,
          stationCode: r.stationCode,
          course: r.course,
          lineTotalSatang: r.unitPriceSatang * l.qty,
          seq: seq++,
          source: 'QR',
          awaitingApproval: settings.qrRequireApproval,
        };
      });
      await tx.insert(orderItems).values(rows).onConflictDoNothing();
      await recalcOrder(tx, o.id);
      let sent: typeof orderItems.$inferSelect[] = [];
      if (!settings.qrRequireApproval) {
        sent = await sendItems(tx, bus, o, { itemIds: rows.map((r) => r.id) });
        await runItemsHook(orderHooks.itemsSent, { db: tx, actor, bus }, o, sent);
        await refreshTableForOrder(tx, bus, o.id);
      }
      await audit(tx, actor, { action: 'qr.order', targetType: 'order', targetId: o.id, data: { items: rows.map((r) => ({ name: r.nameSnapshot, qty: r.qty })), awaitingApproval: settings.qrRequireApproval } }, req.ip);
      return { added: rows.length, sent: sent.length };
    });
    if (result.added) {
      bus.publish({ type: 'order.updated', organizationId: s.order.organizationId, branchId: s.order.branchId, payload: { orderId: s.order.id } });
      bus.publish({
        type: 'call_waiter',
        organizationId: s.order.organizationId,
        branchId: s.order.branchId,
        payload: { tableName: s.tableName ?? `#${s.order.orderNo}`, orderId: s.order.id, label: settings.qrRequireApproval ? `ออเดอร์ QR ${result.added} รายการ รออนุมัติ` : `สั่งผ่าน QR ${result.added} รายการ` },
      });
    }
    return { ...result, requiresApproval: settings.qrRequireApproval, items: await guestOrderView(s.order.id) };
  });

  app.get('/public/qr/:token/order', async (req) => {
    const s = await session(req);
    return { status: s.order.status, grandTotalSatang: s.order.grandTotalSatang, items: await guestOrderView(s.order.id) };
  });

  /** Call waiter / water / ice / request bill — creates a real operational event for staff. */
  app.post('/public/qr/:token/requests', async (req) => {
    const s = await session(req);
    const body = parse(z.object({ type: z.enum(['CALL_WAITER', 'WATER', 'ICE', 'BILL', 'OTHER']), note: z.string().trim().max(150).optional() }), req.body);
    if (!requestLimiter.take(`req:${s.session.id}`)) throw tooMany('ส่งคำขอบ่อยเกินไป พนักงานได้รับแจ้งแล้ว');
    const [open] = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequests)
      .where(and(eq(serviceRequests.orderId, s.order.id), eq(serviceRequests.type, body.type), inArray(serviceRequests.status, ['OPEN', 'ACKNOWLEDGED'])));
    if (open) return { id: open.id, duplicate: true };
    const [r] = await db
      .insert(serviceRequests)
      .values({ organizationId: s.order.organizationId, branchId: s.order.branchId, orderId: s.order.id, tableId: s.session.tableId, type: body.type, note: body.note ?? null })
      .returning();
    bus.publish({ type: 'call_waiter', organizationId: s.order.organizationId, branchId: s.order.branchId, payload: { requestId: r.id, type: body.type, label: REQUEST_LABEL[body.type], tableName: s.tableName ?? `#${s.order.orderNo}`, orderId: s.order.id } });
    return { id: r.id, duplicate: false };
  });

  /** PromptPay QR for the amount still due — shown only when the branch configured PromptPay. Staff confirm receipt. */
  app.get('/public/qr/:token/promptpay', async (req) => {
    const s = await session(req);
    const settings = await branchSettings(db, s.order.branchId);
    if (!settings.enabledPaymentMethods.includes('PROMPTPAY') || !settings.promptPayId) throw notFound('ช่องทาง PromptPay');
    const { confirmed, pending } = await paidAmount(db, s.order.id);
    const due = s.order.grandTotalSatang - confirmed - pending;
    if (due <= 0) throw conflict('ไม่มียอดค้างชำระ');
    const payload = promptPayPayload(settings.promptPayId, due);
    return { amountSatang: due, dataUrl: await QRCode.toDataURL(payload, { margin: 1, width: 300 }), note: 'หลังโอนแล้ว กรุณาแจ้งพนักงานเพื่อยืนยันยอด' };
  });

  // ---------- Queue status ----------
  app.get('/public/queue/:token', async (req) => {
    guard(req);
    const { token } = parse(z.object({ token: z.string().regex(/^[\w-]{10,40}$/) }), req.params);
    const [e] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.publicToken, token));
    if (!e) throw notFound('บัตรคิว');
    const [{ ahead }] = await db
      .select({ ahead: sql<number>`count(*)::int` })
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.branchId, e.branchId), eq(waitlistEntries.businessDate, e.businessDate), inArray(waitlistEntries.status, ['WAITING', 'CALLED']), lt(waitlistEntries.queueNo, e.queueNo)));
    const [b] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, e.branchId));
    const avg = await averageWaitMinutes(db, e.branchId);
    return { branchName: b.name, queueNo: e.queueNo, partySize: e.partySize, status: e.status, ahead, estimatedWaitMinutes: avg !== null && e.status === 'WAITING' ? avg : null };
  });

  // ---------- Web booking ----------
  app.get('/public/branches/:id', async (req) => {
    guard(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [b] = await db.select({ id: branches.id, name: branches.name, address: branches.address, phone: branches.phone }).from(branches).where(and(eq(branches.id, id), isNull(branches.archivedAt)));
    if (!b) throw notFound('สาขา');
    const s = await branchSettings(db, id);
    return { ...b, openTime: s.openTime, closeTime: s.closeTime };
  });

  app.post('/public/branches/:id/reservations', async (req) => {
    guard(req);
    if (!bookingLimiter.take(`book:${req.ip}`)) throw tooMany();
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(reservationBody.pick({ name: true, phone: true, partySize: true, reservedAt: true, notes: true }).extend({ website: z.string().max(0).optional() }), req.body);
    const [b] = await db.select().from(branches).where(and(eq(branches.id, id), isNull(branches.archivedAt)));
    if (!b) throw notFound('สาขา');
    if (body.partySize > 20) throw badRequest('จองเกิน 20 คน กรุณาโทรหาร้าน');
    const reservedAt = new Date(body.reservedAt);
    if (reservedAt.getTime() < Date.now() + 30 * 60_000) throw badRequest('กรุณาจองล่วงหน้าอย่างน้อย 30 นาที');
    const s = await branchSettings(db, id);
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'res:' + id}))`);
      await assertReservable(tx, { branchId: id, reservedAt, durationMinutes: s.reservationSeatingMinutes, partySize: body.partySize });
      const [r] = await tx
        .insert(reservations)
        .values({ organizationId: b.organizationId, branchId: id, name: body.name, phone: body.phone, partySize: body.partySize, reservedAt, durationMinutes: s.reservationSeatingMinutes, channel: 'WEB', notes: body.notes ?? null })
        .returning({ id: reservations.id, reservedAt: reservations.reservedAt, status: reservations.status });
      return r;
    });
    bus.publish({ type: 'reservation.updated', organizationId: b.organizationId, branchId: id, payload: { channel: 'WEB' } });
    return { ...r, message: 'รับการจองแล้ว ร้านจะติดต่อยืนยันอีกครั้ง' };
  });

  /** Live order status for the guest (only events of their own order). */
  app.get('/public/ws', { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token ?? '';
    if (!ipLimiter.take(`ip:${req.ip}`)) return socket.close(4429, 'rate');
    const s = await loadQrSession(db, token);
    if (!s) return socket.close(4401, 'invalid');
    const off = bus.subscribe((e) => {
      if (e.payload.orderId !== s.order.id) return;
      if (!['order_item.status_changed', 'order.updated', 'payment.confirmed', 'service_request.updated', 'kitchen.ticket'].includes(e.type)) return;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: e.type, status: e.payload.status ?? null }));
    });
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000);
    socket.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

}
