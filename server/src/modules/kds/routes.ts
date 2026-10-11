import { and, asc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canTransition, ITEM_TRANSITIONS, type ItemStatus } from '@shared/states';
import { uuid } from '@shared/validation';
import { devices, diningTables, orderItems, orders, stations } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAnyPerm, requireBranch, requirePerm, type AuthContext } from '../../lib/auth';
import { badRequest, conflict, forbidden, notFound, parse } from '../../lib/errors';
import { branchSettings } from '../menu/service';
import { refreshTableForOrder } from '../tables/service';

const KITCHEN_STATUSES = ['SENT', 'PREPARING', 'READY', 'SERVED'] as const;

/** Station a paired KDS device is locked to (null = any station). */
async function deviceStation(db: any, a: AuthContext): Promise<string | null> {
  if (!a.deviceId) return null;
  const [d] = await db
    .select({ code: stations.code, isExpo: stations.isExpo })
    .from(devices)
    .leftJoin(stations, eq(stations.id, devices.stationId))
    .where(eq(devices.id, a.deviceId));
  if (!d?.code || d.isExpo) return null;
  return d.code;
}

export default async function kdsRoutes(app: FastifyInstance) {
  const { db, bus } = app.deps;

  /**
   * Active kitchen tickets for a station (or all stations for Expo). Items are grouped per order so
   * completion is still tracked per order even when the all-day count aggregates them.
   */
  app.get('/kds', async (req) => {
    const a = requirePerm(req, 'kitchen.view');
    const branchId = requireBranch(a);
    const q = parse(z.object({ station: z.string().max(20).optional(), includeReady: z.coerce.boolean().default(true) }), req.query);
    const locked = await deviceStation(db, a);
    const station = locked ?? (q.station && q.station !== 'ALL' ? q.station.toUpperCase() : null);
    const statuses: ItemStatus[] = q.includeReady ? ['SENT', 'PREPARING', 'READY'] : ['SENT', 'PREPARING'];
    const conds: SQL[] = [eq(orderItems.branchId, branchId), inArray(orderItems.status, statuses)];
    if (station) conds.push(eq(orderItems.stationCode, station));
    const rows = await db
      .select({
        item: orderItems,
        orderNo: orders.orderNo,
        channel: orders.channel,
        guestCount: orders.guestCount,
        orderNote: orders.note,
        customerName: orders.customerName,
        tableName: diningTables.name,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(...conds))
      .orderBy(asc(orderItems.sentAt), asc(orderItems.seq));
    const tickets = new Map<string, any>();
    for (const r of rows) {
      const t = tickets.get(r.item.orderId) ?? {
        orderId: r.item.orderId,
        orderNo: r.orderNo,
        channel: r.channel,
        tableName: r.tableName,
        guestCount: r.guestCount,
        customerName: r.customerName,
        orderNote: r.orderNote,
        firstSentAt: r.item.sentAt,
        items: [],
      };
      t.items.push(r.item);
      if (r.item.sentAt && (!t.firstSentAt || r.item.sentAt < t.firstSentAt)) t.firstSentAt = r.item.sentAt;
      tickets.set(r.item.orderId, t);
    }
    const s = await branchSettings(db, branchId);
    return {
      station: station ?? 'ALL',
      lockedStation: locked,
      thresholds: { warnMinutes: s.kdsWarnMinutes, lateMinutes: s.kdsLateMinutes },
      serverTime: new Date().toISOString(),
      tickets: [...tickets.values()],
    };
  });

  /** All-day count: totals of identical items still to cook, per station. */
  app.get('/kds/all-day', async (req) => {
    const a = requirePerm(req, 'kitchen.view');
    const branchId = requireBranch(a);
    const q = parse(z.object({ station: z.string().max(20).optional() }), req.query);
    const locked = await deviceStation(db, a);
    const station = locked ?? (q.station && q.station !== 'ALL' ? q.station.toUpperCase() : null);
    const rows = await db
      .select({ name: orderItems.nameSnapshot, menuItemId: orderItems.menuItemId, qty: sql<number>`sum(${orderItems.qty})::int`, tickets: sql<number>`count(distinct ${orderItems.orderId})::int` })
      .from(orderItems)
      .where(and(eq(orderItems.branchId, branchId), inArray(orderItems.status, ['SENT', 'PREPARING']), station ? eq(orderItems.stationCode, station) : undefined))
      .groupBy(orderItems.nameSnapshot, orderItems.menuItemId)
      .orderBy(sql`sum(${orderItems.qty}) desc`);
    return { station: station ?? 'ALL', counts: rows };
  });

  /** Change kitchen status of one or more items (bump). Invalid transitions are rejected. */
  app.post('/kds/status', async (req) => {
    const a = requireAnyPerm(req, 'kitchen.update', 'order.create');
    const branchId = requireBranch(a);
    const body = parse(z.object({ itemIds: z.array(uuid).min(1).max(100), status: z.enum(KITCHEN_STATUSES) }), req.body);
    // Kitchen staff move items through cooking; front-of-house may only mark READY items as SERVED.
    if (body.status !== 'SERVED' && !a.permissions.has('kitchen.update')) throw forbidden();
    const locked = await deviceStation(db, a);
    const changed = await db.transaction(async (tx) => {
      const items = await tx
        .select()
        .from(orderItems)
        .where(and(inArray(orderItems.id, body.itemIds), eq(orderItems.branchId, branchId)))
        .for('update');
      if (items.length !== body.itemIds.length) throw notFound('รายการ');
      const now = new Date();
      const out = [];
      for (const it of items) {
        if (it.status === body.status) continue; // idempotent
        if (locked && it.stationCode !== locked) throw forbidden(`จอนี้จัดการได้เฉพาะสเตชัน ${locked}`);
        if (!canTransition(ITEM_TRANSITIONS, it.status, body.status)) throw conflict(`"${it.nameSnapshot}" สถานะ ${it.status} เปลี่ยนเป็น ${body.status} ไม่ได้`, 'INVALID_STATE');
        const stamp =
          body.status === 'PREPARING' ? { preparingAt: now } : body.status === 'READY' ? { readyAt: now } : body.status === 'SERVED' ? { servedAt: now } : { preparingAt: null, readyAt: null };
        await tx
          .update(orderItems)
          .set({ status: body.status, ...stamp })
          .where(eq(orderItems.id, it.id));
        out.push({ ...it, from: it.status });
      }
      const backwards = out.filter((i) => KITCHEN_STATUSES.indexOf(body.status) < KITCHEN_STATUSES.indexOf(i.from as (typeof KITCHEN_STATUSES)[number]));
      if (backwards.length || body.status === 'SERVED')
        await audit(tx, a, { action: backwards.length ? 'kitchen.status_reverted' : 'kitchen.served', targetType: 'order_item', targetId: out[0]?.id, data: { items: out.map((i) => ({ id: i.id, name: i.nameSnapshot, from: i.from, to: body.status })) } }, req.ip);
      for (const orderId of new Set(out.map((i) => i.orderId))) await refreshTableForOrder(tx, bus, orderId);
      return out;
    });
    const tables = changed.length
      ? await db
          .select({ orderId: orders.id, tableName: diningTables.name, orderNo: orders.orderNo })
          .from(orders)
          .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
          .where(inArray(orders.id, [...new Set(changed.map((c) => c.orderId))]))
      : [];
    for (const it of changed) {
      const t = tables.find((x) => x.orderId === it.orderId);
      bus.publish({
        type: 'order_item.status_changed',
        organizationId: a.orgId,
        branchId,
        payload: { orderId: it.orderId, itemId: it.id, status: body.status, name: it.nameSnapshot, qty: it.qty, tableName: t?.tableName ?? null, orderNo: t?.orderNo ?? null },
      });
    }
    return { changed: changed.length };
  });

  /** Recently completed items (for "recall" on the KDS). */
  app.get('/kds/recent', async (req) => {
    const a = requirePerm(req, 'kitchen.view');
    const branchId = requireBranch(a);
    const since = new Date(Date.now() - 30 * 60_000);
    const rows = await db
      .select({ item: orderItems, orderNo: orders.orderNo, tableName: diningTables.name })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(eq(orderItems.branchId, branchId), or(and(eq(orderItems.status, 'SERVED'), gte(orderItems.servedAt, since)), and(eq(orderItems.status, 'READY'), gte(orderItems.readyAt, since)))))
      .orderBy(sql`coalesce(${orderItems.servedAt}, ${orderItems.readyAt}) desc`)
      .limit(50);
    return { items: rows.map((r) => ({ ...r.item, orderNo: r.orderNo, tableName: r.tableName })) };
  });

  /** Printable kitchen ticket data (fallback when no KDS screen / for kitchen printers). */
  app.get('/orders/:id/kitchen-ticket', async (req) => {
    const a = requireAnyPerm(req, 'kitchen.view', 'order.send');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(z.object({ station: z.string().max(20).optional(), itemIds: z.string().max(4000).optional() }), req.query);
    const ids = q.itemIds ? q.itemIds.split(',').filter(Boolean) : null;
    if (ids && ids.some((x) => !uuid.safeParse(x).success)) throw badRequest('itemIds ไม่ถูกต้อง');
    const [o] = await db
      .select({ order: orders, tableName: diningTables.name })
      .from(orders)
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(and(eq(orders.id, id), eq(orders.branchId, branchId)));
    if (!o) throw notFound('บิล');
    const items = await db
      .select()
      .from(orderItems)
      .where(
        and(
          eq(orderItems.orderId, id),
          ids ? inArray(orderItems.id, ids) : inArray(orderItems.status, ['SENT', 'PREPARING']),
          q.station ? eq(orderItems.stationCode, q.station.toUpperCase()) : undefined,
        ),
      )
      .orderBy(asc(orderItems.course), asc(orderItems.seq));
    const byStation = new Map<string, typeof items>();
    for (const it of items) byStation.set(it.stationCode ?? '-', [...(byStation.get(it.stationCode ?? '-') ?? []), it]);
    const st = await db.select().from(stations).where(and(eq(stations.branchId, branchId), isNull(stations.archivedAt)));
    return {
      orderNo: o.order.orderNo,
      channel: o.order.channel,
      tableName: o.tableName,
      guestCount: o.order.guestCount,
      customerName: o.order.customerName,
      note: o.order.note,
      printedAt: new Date().toISOString(),
      tickets: [...byStation].map(([code, list]) => ({ station: code, stationName: st.find((s) => s.code === code)?.name ?? code, items: list })),
    };
  });
}
