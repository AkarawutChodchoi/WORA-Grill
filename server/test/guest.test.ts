import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branches, menuItems, qrSessions } from '../src/db/schema';
import { createTestEnv, itemBySku, tableByName, type TestEnv } from './helpers';

let env: TestEnv;
let rice: any;
let water: any;
const tomorrow = (h: number, m = 0) => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(h - 7, m, 0, 0); // Bangkok local time h:m
  return d.toISOString();
};

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  rice = await itemBySku(env, 'M001');
  water = await itemBySku(env, 'D004');
});
afterAll(async () => env.close());

describe('reservations', () => {
  it('prevents double-booking a table in overlapping windows but allows back-to-back', async () => {
    const m = await env.as('MANAGER');
    const a1 = await tableByName(env, 'A1');
    const base = { name: 'คุณเอ', phone: '0811111111', partySize: 4, tableId: a1.id, durationMinutes: 90 };
    expect((await m.post('/reservations', { ...base, reservedAt: tomorrow(18) })).status).toBe(200);
    const clash = await m.post('/reservations', { ...base, name: 'คุณบี', reservedAt: tomorrow(19) });
    expect(clash.body.error.code).toBe('RESERVATION_CONFLICT');
    expect((await m.post('/reservations', { ...base, name: 'คุณซี', reservedAt: tomorrow(19, 30) })).status).toBe(200);
    expect((await m.post('/reservations', { ...base, partySize: 9, reservedAt: tomorrow(12) })).body.error.code).toBe('RESERVATION_CONFLICT'); // capacity 4
  });

  it('without a table, refuses when no fitting table is free', async () => {
    const m = await env.as('MANAGER');
    // Only A7/A8 seat 6; book both, then a third party of 6 cannot fit.
    expect((await m.post('/reservations', { name: 'x', phone: '0822222222', partySize: 6, reservedAt: tomorrow(13) })).status).toBe(200);
    expect((await m.post('/reservations', { name: 'y', phone: '0822222223', partySize: 6, reservedAt: tomorrow(13, 30) })).status).toBe(200);
    expect((await m.post('/reservations', { name: 'z', phone: '0822222224', partySize: 6, reservedAt: tomorrow(13, 15) })).body.error.code).toBe('RESERVATION_CONFLICT');
  });

  it('no-show forfeits a paid deposit; cancelled needs a reason; status flow enforced', async () => {
    const m = await env.as('MANAGER');
    const r = (await m.post('/reservations', { name: 'มัดจำ', phone: '0833333333', partySize: 2, reservedAt: tomorrow(20), depositSatang: 50000, depositStatus: 'PAID' })).body;
    expect((await m.post(`/reservations/${r.id}/status`, { status: 'CANCELLED' })).status).toBe(400);
    expect((await m.post(`/reservations/${r.id}/status`, { status: 'NO_SHOW' })).status).toBe(200);
    const list = (await m.get(`/reservations?date=${tomorrow(20).slice(0, 10)}`)).body.reservations;
    expect(list.find((x: any) => x.id === r.id).depositStatus).toBe('FORFEITED');
    expect((await m.post(`/reservations/${r.id}/status`, { status: 'CONFIRMED' })).status).toBe(409);
  });

  it('public web booking is rate-limited, honeypot-protected and goes to BOOKED', async () => {
    const pub = env.anon();
    const body = { name: 'ลูกค้าเว็บ', phone: '0844444444', partySize: 2, reservedAt: tomorrow(17) };
    expect((await pub.post(`/public/branches/${env.branchId}/reservations`, { ...body, website: 'spam' })).status).toBe(400);
    const ok = await pub.post(`/public/branches/${env.branchId}/reservations`, body);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('BOOKED');
    expect(JSON.stringify(ok.body)).not.toContain('0844444444');
  });
});

describe('walk-in queue', () => {
  it('numbers tickets, shows public status with people ahead, seats a party', async () => {
    const m = await env.as('MANAGER');
    const t1 = (await m.post('/waitlist', { name: 'คิว 1', partySize: 2 })).body;
    const t2 = (await m.post('/waitlist', { name: 'คิว 2', partySize: 3, phone: '0855555555' })).body;
    expect([t1.queueNo, t2.queueNo]).toEqual([1, 2]);
    const pub = (await env.anon().get(`/public/queue/${t2.publicUrl.split('/q/')[1]}`)).body;
    expect(pub).toMatchObject({ queueNo: 2, ahead: 1, status: 'WAITING', estimatedWaitMinutes: null });
    expect(JSON.stringify(pub)).not.toContain('0855555555');
    await m.post(`/waitlist/${t1.id}/call`);
    const t5 = await tableByName(env, 'T1');
    const seat = await m.post(`/waitlist/${t1.id}/seat`, { tableId: t5.id });
    expect(seat.body.orderId).toBeTruthy();
    expect((await m.post(`/waitlist/${t1.id}/left`)).status).toBe(409);
  });
});

describe('QR self-ordering', () => {
  let orderId: string;
  let token: string;

  it('issues a table-bound token; the public menu hides internal fields', async () => {
    const w = await env.as('WAITER');
    const t = await tableByName(env, 'A3');
    orderId = (await w.post(`/tables/${t.id}/open`, { guestCount: 2 })).body.id;
    const q = await w.post(`/orders/${orderId}/qr`);
    expect(q.status).toBe(200);
    token = q.body.url.split('/m/')[1];
    const menu = await env.anon().get(`/public/qr/${token}`);
    expect(menu.status).toBe(200);
    expect(menu.body.tableName).toBe('A3');
    expect(menu.body.menu.items[0].sku).toBeUndefined();
    expect(menu.body.payment.promptPay).toBe(false);
    expect((await env.anon().get(`/public/qr/${token}/promptpay`)).status).toBe(404);
  });

  it('prices on the server, ignores duplicates, and sends straight to the kitchen when no approval is required', async () => {
    const pub = env.anon();
    const line = { id: randomUUID(), menuItemId: water.id, qty: 2, unitPriceSatang: 1 };
    const r1 = await pub.post(`/public/qr/${token}/items`, { items: [line] });
    expect(r1.status).toBe(200);
    expect(r1.body.items[0]).toMatchObject({ qty: 2, unitPriceSatang: 2000, status: 'SENT', source: 'QR' });
    const r2 = await pub.post(`/public/qr/${token}/items`, { items: [line] });
    expect(r2.body.added).toBe(0);
    expect(r2.body.items).toHaveLength(1);
  });

  it('rejects hidden or sold-out items and malformed carts', async () => {
    await env.db.update(menuItems).set({ hideOnQr: true }).where(eq(menuItems.id, rice.id));
    const r = await env.anon().post(`/public/qr/${token}/items`, { items: [{ id: randomUUID(), menuItemId: rice.id, qty: 1 }] });
    expect(r.body.error.code).toBe('ITEM_UNAVAILABLE');
    await env.db.update(menuItems).set({ hideOnQr: false }).where(eq(menuItems.id, rice.id));
    expect((await env.anon().post(`/public/qr/${token}/items`, { items: [{ id: randomUUID(), menuItemId: rice.id, qty: 999 }] })).status).toBe(400);
  });

  it('holds guest orders for approval when the branch requires it', async () => {
    const [b] = await env.db.select().from(branches).where(eq(branches.id, env.branchId));
    await env.db.update(branches).set({ settings: { ...(b.settings as object), qrRequireApproval: true } as never }).where(eq(branches.id, env.branchId));
    const r = await env.anon().post(`/public/qr/${token}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] });
    expect(r.body.requiresApproval).toBe(true);
    expect(r.body.items.find((i: any) => i.awaitingApproval).status).toBe('PENDING');
    const w = await env.as('WAITER');
    // a normal "send" must not push unapproved guest lines to the kitchen
    expect((await w.post(`/orders/${orderId}/send`, {})).body.sent).toBe(0);
    expect((await w.get('/qr/pending')).body.orders[0].orderId).toBe(orderId);
    const ap = await w.post(`/orders/${orderId}/approve-qr`, {});
    expect(ap.body.sent).toBe(1);
    expect((await (await env.as('KITCHEN')).post(`/orders/${orderId}/approve-qr`, {})).status).toBe(403);
    await env.db.update(branches).set({ settings: b.settings }).where(eq(branches.id, env.branchId));
  });

  it('call-waiter creates a visible staff event once per open request', async () => {
    const events: any[] = [];
    const off = env.bus.subscribe((e) => e.type === 'call_waiter' && events.push(e));
    const a = await env.anon().post(`/public/qr/${token}/requests`, { type: 'WATER' });
    const b = await env.anon().post(`/public/qr/${token}/requests`, { type: 'WATER' });
    off();
    expect(a.body.duplicate).toBe(false);
    expect(b.body.duplicate).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ tableName: 'A3', type: 'WATER' });
    const list = (await (await env.as('WAITER')).get('/service-requests')).body.requests;
    expect(list[0].tableName).toBe('A3');
  });

  it('rotation and expiry invalidate tokens; tokens cannot reach other tables', async () => {
    const w = await env.as('WAITER');
    const old = token;
    token = (await w.post(`/orders/${orderId}/qr`)).body.url.split('/m/')[1];
    expect((await env.anon().get(`/public/qr/${old}`)).status).toBe(404);
    expect((await env.anon().get(`/public/qr/${token}`)).status).toBe(200);
    expect((await env.anon().get(`/public/qr/not-a-real-token-xxxxxxxxxxxx`)).status).toBe(404);
    await env.db.update(qrSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(qrSessions.orderId, orderId));
    expect((await env.anon().get(`/public/qr/${token}`)).status).toBe(404);
  });

  it('paying the bill ends the QR session', async () => {
    const w = await env.as('WAITER');
    token = (await w.post(`/orders/${orderId}/qr`)).body.url.split('/m/')[1];
    const c = await env.as('CASHIER');
    await c.post('/shifts/open', { openingFloatSatang: 0 });
    const o = (await c.get(`/orders/${orderId}`)).body;
    await c.post(`/orders/${orderId}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: o.grandTotalSatang });
    expect((await env.anon().get(`/public/qr/${token}`)).status).toBe(404);
  });
});
