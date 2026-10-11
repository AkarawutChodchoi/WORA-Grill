import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestEnv, itemBySku, tableByName, TEST_PIN, type TestEnv } from './helpers';

let env: TestEnv;
let rice: any; // HOT
let tea: any; // BAR (needs size)
let orderId: string;
const ids = { rice: randomUUID(), rice2: randomUUID(), tea: randomUUID() };

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  rice = await itemBySku(env, 'M001');
  tea = await itemBySku(env, 'D001');
  const w = await env.as('WAITER');
  const t = await tableByName(env, 'A1');
  orderId = (await w.post(`/tables/${t.id}/open`, { guestCount: 2 })).body.id;
  const menu = (await w.get('/menu')).body;
  const size = menu.items.find((i: any) => i.id === tea.id).modifierGroups.find((g: any) => g.name === 'ขนาดแก้ว').modifiers[0].id;
  await w.post(`/orders/${orderId}/items`, {
    send: true,
    items: [
      { id: ids.rice, menuItemId: rice.id, qty: 2, note: 'ไม่ใส่ผัก' },
      { id: ids.tea, menuItemId: tea.id, qty: 1, modifiers: [{ modifierId: size }] },
    ],
  });
  // a second table with the same dish for the all-day count
  const t2 = await tableByName(env, 'A2');
  const o2 = (await w.post(`/tables/${t2.id}/open`, { guestCount: 1 })).body.id;
  await w.post(`/orders/${o2}/items`, { send: true, items: [{ id: ids.rice2, menuItemId: rice.id, qty: 3 }] });
});
afterAll(async () => env.close());

describe('kitchen display', () => {
  it('routes items to stations by category', async () => {
    const k = await env.as('KITCHEN');
    const hot = (await k.get('/kds?station=HOT')).body;
    const bar = (await k.get('/kds?station=BAR')).body;
    const hotItems = hot.tickets.flatMap((t: any) => t.items.map((i: any) => i.id));
    expect(hotItems).toEqual(expect.arrayContaining([ids.rice, ids.rice2]));
    expect(hotItems).not.toContain(ids.tea);
    expect(bar.tickets[0].items[0].id).toBe(ids.tea);
    expect(hot.tickets[0].tableName).toBe('A1');
    expect(hot.tickets[0].items[0].note).toBe('ไม่ใส่ผัก');
    expect(hot.tickets[0].items[0].allergens).toContain('shellfish');
    expect(hot.thresholds.warnMinutes).toBe(10);
  });

  it('aggregates an all-day count while keeping per-order tickets', async () => {
    const k = await env.as('KITCHEN');
    const r = (await k.get('/kds/all-day?station=HOT')).body;
    expect(r.counts.find((c: any) => c.name === 'ข้าวผัดกุ้ง')).toMatchObject({ qty: 5, tickets: 2 });
  });

  it('moves items through SENT → PREPARING → READY and rejects invalid jumps', async () => {
    const k = await env.as('KITCHEN');
    expect((await k.post('/kds/status', { itemIds: [ids.rice], status: 'SERVED' })).status).toBe(409);
    expect((await k.post('/kds/status', { itemIds: [ids.rice], status: 'PREPARING' })).body.changed).toBe(1);
    expect((await k.post('/kds/status', { itemIds: [ids.rice], status: 'PREPARING' })).body.changed).toBe(0); // idempotent
    expect((await tableByName(env, 'A1')).status).toBe('WAITING_FOOD');
    const events: any[] = [];
    const off = env.bus.subscribe((e) => events.push(e));
    expect((await k.post('/kds/status', { itemIds: [ids.rice], status: 'READY' })).status).toBe(200);
    off();
    expect(events.find((e) => e.type === 'order_item.status_changed')?.payload).toMatchObject({ status: 'READY', tableName: 'A1' });
  });

  it('front-of-house may only mark ready items served; waiters cannot cook', async () => {
    const w = await env.as('WAITER');
    expect((await w.post('/kds/status', { itemIds: [ids.tea], status: 'PREPARING' })).status).toBe(403);
    expect((await w.post('/kds/status', { itemIds: [ids.rice], status: 'SERVED' })).status).toBe(200);
    expect((await env.as('KITCHEN').then((k) => k.get('/kds/recent'))).body.items.map((i: any) => i.id)).toContain(ids.rice);
  });

  it('a KDS device bound to a station only sees and updates that station', async () => {
    const m = await env.as('MANAGER');
    const pair = await m.post('/auth/terminal', { name: 'KDS bar', kind: 'KDS' });
    const stations = (await m.get('/stations')).body.stations;
    const bar = stations.find((s: any) => s.code === 'BAR');
    await m.patch(`/devices/${pair.body.id}`, { stationId: bar.id });
    const device = new Client(env.app, m.cookie.split('; ').find((c) => c.startsWith('rms_device='))!);
    expect((await device.post('/auth/pin-login', { userId: env.userIds.KITCHEN, pin: TEST_PIN })).status).toBe(200);
    const view = (await device.get('/kds?station=HOT')).body; // requested HOT, but device is locked to BAR
    expect(view.station).toBe('BAR');
    expect(view.tickets.flatMap((t: any) => t.items.map((i: any) => i.id))).toEqual([ids.tea]);
    expect((await device.post('/kds/status', { itemIds: [ids.rice2], status: 'PREPARING' })).status).toBe(403);
    expect((await device.post('/kds/status', { itemIds: [ids.tea], status: 'PREPARING' })).status).toBe(200);
  });

  it('86 from the kitchen blocks new orders of that item', async () => {
    const k = await env.as('KITCHEN');
    await k.post(`/menu/items/${rice.id}/sold-out`, { soldOut: true });
    const w = await env.as('WAITER');
    const r = await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: rice.id, qty: 1 }] });
    expect(r.body.error.code).toBe('ITEM_UNAVAILABLE');
    await k.post(`/menu/items/${rice.id}/sold-out`, { soldOut: false });
  });

  it('provides a printable kitchen ticket grouped by station', async () => {
    const k = await env.as('KITCHEN');
    const r = (await k.get(`/orders/${orderId}/kitchen-ticket?itemIds=${ids.rice},${ids.tea}`)).body;
    expect(r.tableName).toBe('A1');
    expect(r.tickets.map((t: any) => t.station).sort()).toEqual(['BAR', 'HOT']);
    expect((await (await env.as('STOREKEEPER')).get('/kds')).status).toBe(403);
  });
});
