import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveBranchSettings } from '@shared/settings';
import { approvalSchema, satang, uuid } from '@shared/validation';
import { branches, devices, diningTables, ingredients, notificationReads, orderItems, orders, payments, stations, users, webhookEvents } from '../../db/schema';
import type { DbOrTx } from '../../db/client';
import { createLineNotifier, type LineNotifier } from '../../integrations/line';
import { createOpnGateway, type PaymentGateway } from '../../integrations/opn';
import { kitchenDocument, printerConfigSchema, receiptDocument, tcpTransport, type PrinterConfig, type PrinterTransport } from '../../integrations/printers';
import { audit } from '../../lib/audit';
import { authorizeSensitive, requireAuth, requireBranch, requirePerm } from '../../lib/auth';
import { AppError, badRequest, conflict, notFound, parse, unprocessable } from '../../lib/errors';
import { loadBranchMenu, resolveLine } from '../menu/service';
import { createOrder } from '../orders/create';
import { orderHooks, runItemsHook } from '../orders/hooks';
import { getOrderDetail, lockOrder, nextSeq, recalcOrder, sendItems } from '../orders/service';
import { openShiftFor, paidAmount, settleOrder } from '../payments/service';
import { listNotifications, notify } from './notify';

export interface Integrations {
  gateway: PaymentGateway;
  line: LineNotifier;
  printer: PrinterTransport;
}

const SYSTEM = (orgId: string, branchId: string) => ({ orgId, branchId, userId: null as unknown as string });

/** Printers (devices of kind PRINTER) of a branch with valid configuration. */
async function branchPrinters(db: DbOrTx, branchId: string) {
  const rows = await db.select().from(devices).where(and(eq(devices.branchId, branchId), eq(devices.kind, 'PRINTER'), isNull(devices.revokedAt)));
  return rows.flatMap((d) => {
    const cfg = printerConfigSchema.safeParse(d.config);
    return cfg.success ? [{ device: d, cfg: cfg.data as PrinterConfig }] : [];
  });
}

export default async function integrationRoutes(app: FastifyInstance) {
  const { db, bus, config } = app.deps;
  const integrations: Integrations = {
    gateway: app.deps.integrations?.gateway ?? createOpnGateway(config),
    line: app.deps.integrations?.line ?? createLineNotifier(config, undefined, (m) => app.log.warn(m)),
    printer: app.deps.integrations?.printer ?? tcpTransport,
  };

  const printFailed = async (orgId: string, branchId: string, what: string, err: unknown) => {
    app.log.warn({ err }, `print failed: ${what}`);
    await notify(db, bus, { orgId, branchId, kind: 'print_failed', title: `พิมพ์${what}ไม่สำเร็จ`, body: `${(err as Error).message} — ใช้ปุ่ม "พิมพ์" ในหน้าจอ (พิมพ์ผ่านเบราว์เซอร์) แทนได้`, requiredPermission: 'order.view' });
  };

  /** Kitchen tickets → station printers (fallback/complement to the KDS screen). */
  const printKitchen = async (orgId: string, branchId: string, orderId: string, itemIds: string[]) => {
    const printers = (await branchPrinters(db, branchId)).filter((p) => p.cfg.role === 'KITCHEN');
    if (!printers.length) return 0;
    const [o] = await db.select({ o: orders, tableName: diningTables.name }).from(orders).leftJoin(diningTables, eq(diningTables.id, orders.tableId)).where(eq(orders.id, orderId));
    const items = itemIds.length ? await db.select().from(orderItems).where(inArray(orderItems.id, itemIds)) : [];
    const st = await db.select().from(stations).where(eq(stations.branchId, branchId));
    let printed = 0;
    for (const p of printers) {
      const station = st.find((s) => s.id === p.device.stationId);
      const mine = station ? items.filter((i) => i.stationCode === station.code) : items;
      if (!mine.length) continue;
      try {
        await integrations.printer.send(
          p.cfg,
          kitchenDocument({ stationName: station?.name ?? 'ครัว', orderNo: o.o.orderNo, tableName: o.tableName, channel: o.o.channel, guestCount: o.o.guestCount, printedAt: new Date(), items: mine }, p.cfg),
        );
        printed++;
      } catch (e) {
        await printFailed(orgId, branchId, `ใบสั่งครัว (${p.device.name})`, e);
      }
    }
    return printed;
  };

  // ---------- Event-driven side effects (after the triggering transaction committed) ----------
  const off = bus.subscribe((e) => {
    const branchId = e.branchId;
    if (!branchId) return;
    setTimeout(() => {
      void (async () => {
        if (e.type === 'kitchen.ticket' && config.AUTO_KITCHEN_PRINT === 'true') await printKitchen(e.organizationId, branchId, String(e.payload.orderId), (e.payload.itemIds as string[]) ?? []);
        if (e.type === 'stock.low') {
          const [ing] = await db.select({ name: ingredients.name }).from(ingredients).where(eq(ingredients.id, String(e.payload.ingredientId)));
          const text = `วัตถุดิบใกล้หมด: ${ing?.name ?? ''} (คงเหลือ ${Number(e.payload.balance).toLocaleString()})`;
          await notify(db, null, { orgId: e.organizationId, branchId, kind: 'stock_low', title: text, link: '/inventory', requiredPermission: 'inventory.view' });
          await integrations.line.push(text);
        }
        if (e.type === 'reservation.updated' && e.payload.channel === 'WEB') {
          await notify(db, null, { orgId: e.organizationId, branchId, kind: 'reservation_web', title: 'มีการจองใหม่จากเว็บไซต์ รอยืนยัน', link: '/reservations', requiredPermission: 'reservation.manage' });
          await integrations.line.push('มีการจองโต๊ะใหม่จากเว็บไซต์ รอยืนยัน');
        }
      })().catch((err) => app.log.error({ err }, 'integration side-effect failed'));
    }, 150);
  });
  app.addHook('onClose', async () => off());

  // ---------- Status ----------
  app.get('/integrations/status', async (req) => {
    requirePerm(req, 'settings.manage');
    const a = requireAuth(req);
    const printers = a.branchId ? await branchPrinters(db, a.branchId) : [];
    return {
      paymentGateway: { provider: 'opn', enabled: integrations.gateway.enabled, webhookVerified: !!config.OPN_WEBHOOK_SECRET },
      line: { enabled: integrations.line.enabled },
      delivery: { enabled: !!config.DELIVERY_WEBHOOK_SECRET, note: 'GrabFood/LINE MAN/ShopeeFood ต้องมีสัญญาพาร์ทเนอร์และ middleware ที่ส่งออเดอร์มายัง /api/webhooks/delivery' },
      printers: printers.map((p) => ({ id: p.device.id, name: p.device.name, role: p.cfg.role, host: p.cfg.host, port: p.cfg.port })),
      email: { enabled: false, note: 'ยังไม่มี SMTP — ส่งออกรายงานเป็น CSV/PDF แทน' },
    };
  });

  // ---------- Notifications ----------
  app.get('/notifications', async (req) => {
    const a = requireAuth(req);
    return { notifications: await listNotifications(db, a) };
  });
  app.post('/notifications/read', async (req) => {
    const a = requireAuth(req);
    const { ids } = parse(z.object({ ids: z.array(uuid).max(200) }), req.body);
    if (ids.length) await db.insert(notificationReads).values(ids.map((notificationId) => ({ notificationId, userId: a.userId }))).onConflictDoNothing();
    return { ok: true };
  });

  // ---------- Printing ----------
  app.post('/orders/:id/print', async (req) => {
    const a = requirePerm(req, 'order.view');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ kind: z.enum(['receipt', 'kitchen']), deviceId: uuid.optional(), openDrawer: z.boolean().default(false) }), req.body);
    if (body.kind === 'kitchen') {
      const items = await db.select({ id: orderItems.id }).from(orderItems).where(and(eq(orderItems.orderId, id), eq(orderItems.branchId, branchId), inArray(orderItems.status, ['SENT', 'PREPARING'])));
      const n = await printKitchen(a.orgId, branchId, id, items.map((i) => i.id));
      if (!n) throw unprocessable('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ครัว ใช้การพิมพ์ผ่านเบราว์เซอร์แทน', 'NO_PRINTER');
      return { printed: n };
    }
    // Kicking the drawer after a cash sale is part of taking payment.
    if (body.openDrawer && !a.permissions.has('payment.take')) throw new AppError(403, 'FORBIDDEN', 'ไม่มีสิทธิ์เปิดลิ้นชัก');
    const printers = (await branchPrinters(db, branchId)).filter((p) => p.cfg.role === 'RECEIPT' && (!body.deviceId || p.device.id === body.deviceId));
    if (!printers.length) throw unprocessable('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ใบเสร็จ ใช้การพิมพ์ผ่านเบราว์เซอร์แทน', 'NO_PRINTER');
    const order = await getOrderDetail(db, a.orgId, branchId, id);
    const [b] = await db.select().from(branches).where(eq(branches.id, branchId));
    const s = resolveBranchSettings(b.settings);
    const [cashier] = order.closedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, order.closedBy)) : [];
    const doc = receiptDocument(
      { seller: { name: b.name, address: b.address, phone: b.phone, taxId: b.taxId, header: s.receiptHeader, footer: s.receiptFooter }, isTaxInvoice: !!b.taxId && s.vatMode !== 'NONE', order: { ...order, payments: (order as any).payments ?? [] }, cashier: cashier?.name ?? null },
      printers[0].cfg,
      { openDrawer: body.openDrawer },
    );
    try {
      await integrations.printer.send(printers[0].cfg, doc);
    } catch (e) {
      throw new AppError(502, 'PRINTER_ERROR', `เครื่องพิมพ์ไม่ตอบสนอง: ${(e as Error).message}`);
    }
    if (body.openDrawer) await audit(db, a, { action: 'cash.drawer_kick', targetType: 'order', targetId: id }, req.ip);
    return { printed: 1 };
  });

  /** Open the cash drawer without a sale (needs cash.open_drawer or manager PIN; always audited). */
  app.post('/devices/open-drawer', async (req) => {
    const a = requirePerm(req, 'shift.open');
    const branchId = requireBranch(a);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(200), approval: approvalSchema }), req.body);
    const approver = await authorizeSensitive(db, a, 'cash.open_drawer', body.approval);
    const printer = (await branchPrinters(db, branchId)).find((p) => p.cfg.role === 'RECEIPT' && p.cfg.openDrawer);
    if (!printer) throw unprocessable('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ที่ต่อลิ้นชักเงิน', 'NO_PRINTER');
    const shift = await openShiftFor(db, branchId, a.userId);
    const { EscPos } = await import('../../integrations/escpos');
    await integrations.printer.send(printer.cfg, new EscPos(printer.cfg.width, printer.cfg.codePage).openDrawer().build());
    await audit(db, a, { action: 'cash.open_drawer', targetType: 'shift', targetId: shift?.id ?? null, reason: body.reason, approverUserId: approver }, req.ip);
    return { ok: true };
  });

  app.post('/devices/:id/test-print', async (req) => {
    const a = requirePerm(req, 'device.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const p = (await branchPrinters(db, branchId)).find((x) => x.device.id === id);
    if (!p) throw notFound('เครื่องพิมพ์ที่ตั้งค่าแล้ว');
    const { EscPos } = await import('../../integrations/escpos');
    const doc = new EscPos(p.cfg.width, p.cfg.codePage).align('center').bold(true).text('ทดสอบเครื่องพิมพ์').bold(false).text(p.device.name).text(new Date().toLocaleString('th-TH')).feed(3).cut().build();
    try {
      await integrations.printer.send(p.cfg, doc);
    } catch (e) {
      throw new AppError(502, 'PRINTER_ERROR', `เชื่อมต่อเครื่องพิมพ์ไม่ได้: ${(e as Error).message}`);
    }
    return { ok: true };
  });

  /** Register a network printer (no browser pairing needed). */
  app.post('/devices/printers', async (req) => {
    const a = requirePerm(req, 'device.manage');
    const branchId = requireBranch(a);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), stationId: uuid.nullable().optional(), config: printerConfigSchema }), req.body);
    if (body.stationId) {
      const [s] = await db.select().from(stations).where(and(eq(stations.id, body.stationId), eq(stations.branchId, branchId)));
      if (!s) throw badRequest('สเตชันไม่ถูกต้อง');
    }
    const [d] = await db.insert(devices).values({ organizationId: a.orgId, branchId, name: body.name, kind: 'PRINTER', stationId: body.stationId ?? null, config: body.config, createdBy: a.userId }).returning();
    await audit(db, a, { action: 'device.printer_add', targetType: 'device', targetId: d.id, data: { name: body.name, host: body.config.host } }, req.ip);
    return d;
  });

  // ---------- PromptPay through the payment gateway (auto-confirmation via signed webhook) ----------
  app.post('/orders/:id/payments/gateway', async (req) => {
    const a = requirePerm(req, 'payment.take');
    const branchId = requireBranch(a);
    if (!integrations.gateway.enabled) throw new AppError(503, 'GATEWAY_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า Payment Gateway — ใช้ PromptPay แบบยืนยันด้วยตนเอง');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ paymentId: uuid, amountSatang: satang.min(2000) }), req.body);
    const [dup] = await db.select().from(payments).where(eq(payments.id, body.paymentId));
    if (dup) return { paymentId: dup.id, providerRef: dup.providerRef, qrImageUrl: null, status: dup.status };
    const o = await getOrderDetail(db, a.orgId, branchId, id);
    if (!['OPEN', 'BILL_REQUESTED'].includes(o.status)) throw conflict('บิลนี้ชำระครบหรือปิดแล้ว');
    const shift = await openShiftFor(db, branchId, a.userId);
    if (!shift) throw unprocessable('กรุณาเปิดกะก่อนรับชำระเงิน', 'NO_OPEN_SHIFT');
    const { confirmed, pending } = await paidAmount(db, id);
    if (body.amountSatang > o.grandTotalSatang - confirmed - pending) throw unprocessable('ยอดเกินกว่าที่ต้องชำระ', 'OVERPAYMENT');
    // Charge first (outside the DB transaction: network call), then record it as pending.
    const charge = await integrations.gateway.createPromptPayCharge(body.amountSatang, { paymentId: body.paymentId, orderId: id });
    await db.insert(payments).values({ id: body.paymentId, organizationId: a.orgId, branchId, orderId: id, shiftId: shift.id, method: 'PROMPTPAY', status: 'PENDING_CONFIRMATION', amountSatang: body.amountSatang, provider: integrations.gateway.name, providerRef: charge.id, createdBy: a.userId });
    await audit(db, a, { action: 'payment.gateway_charge', targetType: 'payment', targetId: body.paymentId, data: { orderId: id, amount: body.amountSatang, providerRef: charge.id } }, req.ip);
    return { paymentId: body.paymentId, providerRef: charge.id, qrImageUrl: charge.qrImageUrl, status: 'PENDING_CONFIRMATION' };
  });

  // ---------- Inbound webhooks (raw body needed for signature verification) ----------
  await app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    hooks.post('/webhooks/payments/opn', async (req, reply) => {
      const raw = req.body as Buffer;
      if (!integrations.gateway.verifyWebhook(raw, req.headers)) return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'invalid signature' } });
      let evt: any;
      try {
        evt = JSON.parse(raw.toString('utf8'));
      } catch {
        throw badRequest('invalid json');
      }
      const eventId = String(evt?.id ?? '');
      if (!eventId) throw badRequest('missing event id');
      const inserted = await db.insert(webhookEvents).values({ provider: 'opn', eventId, eventType: String(evt.key ?? ''), summary: { chargeId: evt?.data?.id, status: evt?.data?.status } }).onConflictDoNothing().returning();
      if (!inserted.length) return { ok: true, duplicate: true };
      const chargeId = String(evt?.data?.id ?? '');
      if (evt.key !== 'charge.complete' || !chargeId) {
        await db.update(webhookEvents).set({ status: 'IGNORED', processedAt: new Date() }).where(eq(webhookEvents.id, inserted[0].id));
        return { ok: true, ignored: true };
      }
      try {
        // Never trust the webhook payload alone: re-read the charge from the provider.
        const charge = await integrations.gateway.getCharge(chargeId);
        const [p] = await db.select().from(payments).where(and(eq(payments.provider, integrations.gateway.name), eq(payments.providerRef, chargeId)));
        if (!p) throw new Error('unknown charge');
        if (charge.status === 'successful' && charge.amountSatang === p.amountSatang && p.status === 'PENDING_CONFIRMATION') {
          await db.transaction(async (tx) => {
            await lockOrder(tx, p.organizationId, p.branchId, p.orderId);
            await tx.update(payments).set({ status: 'CONFIRMED', confirmedAt: new Date(), reference: chargeId }).where(eq(payments.id, p.id));
            await audit(tx, SYSTEM(p.organizationId, p.branchId), { action: 'payment.gateway_confirmed', targetType: 'payment', targetId: p.id, data: { chargeId, amount: p.amountSatang } });
            await settleOrder(tx, bus, SYSTEM(p.organizationId, p.branchId), p.orderId, p.shiftId);
          });
          bus.publish({ type: 'order.updated', organizationId: p.organizationId, branchId: p.branchId, payload: { orderId: p.orderId } });
        } else if (['failed', 'expired'].includes(charge.status) && p.status === 'PENDING_CONFIRMATION') {
          await db.update(payments).set({ status: 'VOIDED', voidedAt: new Date() }).where(eq(payments.id, p.id));
          bus.publish({ type: 'order.updated', organizationId: p.organizationId, branchId: p.branchId, payload: { orderId: p.orderId } });
        }
        await db.update(webhookEvents).set({ status: 'PROCESSED', processedAt: new Date() }).where(eq(webhookEvents.id, inserted[0].id));
        return { ok: true };
      } catch (e) {
        await db.update(webhookEvents).set({ status: 'FAILED', error: (e as Error).message.slice(0, 300), processedAt: new Date() }).where(eq(webhookEvents.id, inserted[0].id));
        throw e;
      }
    });

    /**
     * Delivery-platform orders in a normalised format, posted by an integration middleware that holds the
     * official GrabFood/LINE MAN/ShopeeFood partner credentials. Signed with HMAC-SHA256 (X-Signature).
     */
    hooks.post('/webhooks/delivery/:provider', async (req, reply) => {
      const { provider } = parse(z.object({ provider: z.enum(['GRAB', 'LINEMAN', 'SHOPEEFOOD']) }), req.params);
      const secret = config.DELIVERY_WEBHOOK_SECRET;
      if (!secret) return reply.status(503).send({ error: { code: 'NOT_CONFIGURED', message: 'delivery integration not configured' } });
      const raw = req.body as Buffer;
      const expected = createHmac('sha256', secret).update(raw).digest();
      const got = Buffer.from(String(req.headers['x-signature'] ?? ''), 'hex');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'invalid signature' } });
      const body = parse(
        z.object({
          eventId: z.string().min(1).max(100),
          branchCode: z.string().min(1).max(20),
          externalOrderId: z.string().min(1).max(100),
          customerName: z.string().max(100).optional(),
          note: z.string().max(300).optional(),
          items: z.array(z.object({ sku: z.string().min(1).max(40), qty: z.number().int().min(1).max(50), note: z.string().max(150).optional() })).min(1).max(100),
        }),
        JSON.parse(raw.toString('utf8')),
      );
      const inserted = await db.insert(webhookEvents).values({ provider: `delivery:${provider}`, eventId: body.eventId, eventType: 'order.created', summary: { externalOrderId: body.externalOrderId, items: body.items.length } }).onConflictDoNothing().returning();
      if (!inserted.length) return { ok: true, duplicate: true };
      const [b] = await db.select().from(branches).where(eq(branches.code, body.branchCode));
      if (!b) throw notFound('สาขา');
      const [existing] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.branchId, b.id), eq(orders.externalRef, `${provider}:${body.externalOrderId}`)));
      if (existing) return { ok: true, duplicate: true, orderId: existing.id };
      const orderId = await db.transaction(async (tx) => {
        const { order } = await createOrder(tx, { orgId: b.organizationId, branchId: b.id, channel: provider, source: 'DELIVERY_API', customerName: body.customerName ?? null, note: body.note ?? null, externalRef: `${provider}:${body.externalOrderId}` });
        const menu = await loadBranchMenu(tx, { orgId: b.organizationId, branchId: b.id, channel: provider });
        let seq = await nextSeq(tx, order.id);
        const rows = body.items.map((l) => {
          const item = menu.items.find((m) => m.sku === l.sku);
          if (!item) throw unprocessable(`ไม่พบเมนูรหัส ${l.sku}`, 'UNKNOWN_SKU');
          // Platform modifiers are not mapped yet: items with required options are rejected for manual entry.
          const r = resolveLine(menu, { menuItemId: item.id, qty: l.qty, modifiers: [] });
          return { id: crypto.randomUUID(), orderId: order.id, organizationId: b.organizationId, branchId: b.id, menuItemId: r.menuItemId, nameSnapshot: r.name, nameEnSnapshot: r.nameEn, basePriceSatang: r.basePriceSatang, unitPriceSatang: r.unitPriceSatang, qty: l.qty, modifiers: [], comboComponents: r.comboComponents, allergens: r.allergens, note: l.note ?? null, stationCode: r.stationCode, course: r.course, lineTotalSatang: r.unitPriceSatang * l.qty, seq: seq++, source: 'DELIVERY_API' };
        });
        await tx.insert(orderItems).values(rows);
        const o2 = await recalcOrder(tx, order.id);
        const sent = await sendItems(tx, bus, o2, {});
        await runItemsHook(orderHooks.itemsSent, { db: tx, actor: SYSTEM(b.organizationId, b.id), bus }, o2, sent);
        await audit(tx, SYSTEM(b.organizationId, b.id), { action: 'delivery.order_received', targetType: 'order', targetId: order.id, data: { provider, externalOrderId: body.externalOrderId } });
        return order.id;
      });
      await db.update(webhookEvents).set({ status: 'PROCESSED', processedAt: new Date() }).where(eq(webhookEvents.id, inserted[0].id));
      bus.publish({ type: 'order.created', organizationId: b.organizationId, branchId: b.id, payload: { orderId } });
      return { ok: true, orderId };
    });
  });

}
