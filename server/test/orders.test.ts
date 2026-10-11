import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { menuItems } from '../src/db/schema';
import { createTestEnv, itemBySku, tableByName, TEST_PIN, type TestEnv } from './helpers';

let env: TestEnv;
let friedRice: any; // M001 90.00, extras group
let kaprao: any; // M002 70.00, spice (required) + extras
let water: any; // D004 20.00

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  friedRice = await itemBySku(env, 'M001');
  kaprao = await itemBySku(env, 'M002');
  water = await itemBySku(env, 'D004');
});
afterAll(async () => env.close());

async function openTable(name: string, guests = 2) {
  const w = await env.as('WAITER');
  const t = await tableByName(env, name);
  const r = await w.post(`/tables/${t.id}/open`, { guestCount: guests });
  expect(r.status).toBe(200);
  return r.body.id as string;
}
async function spiceMod(name = 'เผ็ดน้อย') {
  const menu = (await (await env.as('WAITER')).get('/menu')).body;
  return menu.items.find((i: any) => i.id === kaprao.id).modifierGroups[0].modifiers.find((m: any) => m.name === name).id as string;
}

describe('POS orders', () => {
  it('adds items with server prices, snapshots and running totals', async () => {
    const orderId = await openTable('A1');
    const w = await env.as('WAITER');
    const r = await w.post(`/orders/${orderId}/items`, {
      items: [
        { id: randomUUID(), menuItemId: friedRice.id, qty: 2, note: 'ไม่ใส่ผัก' },
        { id: randomUUID(), menuItemId: kaprao.id, qty: 1, modifiers: [{ modifierId: await spiceMod() }] },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].status).toBe('PENDING');
    expect(r.body.items[0].nameSnapshot).toBe('ข้าวผัดกุ้ง');
    expect(r.body.items[0].note).toBe('ไม่ใส่ผัก');
    expect(r.body.items[0].allergens).toContain('shellfish');
    // 2×90 + 70 = 250; +10% service = 25; VAT 7% of 275 = 19.25 → total 294.25
    expect(r.body.subtotalSatang).toBe(25000);
    expect(r.body.serviceChargeSatang).toBe(2500);
    expect(r.body.vatSatang).toBe(1925);
    expect(r.body.grandTotalSatang).toBe(29425);
  });

  it('rejects client-sent prices being trusted, missing required modifiers and unavailable items', async () => {
    const orderId = await openTable('A2');
    const w = await env.as('WAITER');
    const noSpice = await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: kaprao.id, qty: 1 }] });
    expect(noSpice.status).toBe(422);
    expect(noSpice.body.error.code).toBe('INVALID_MODIFIERS');
    const k = await env.as('KITCHEN');
    await k.post(`/menu/items/${water.id}/sold-out`, { soldOut: true });
    const soldOut = await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] });
    expect(soldOut.status).toBe(422);
    expect(soldOut.body.error.code).toBe('ITEM_UNAVAILABLE');
    await k.post(`/menu/items/${water.id}/sold-out`, { soldOut: false });
    const priced = await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1, unitPriceSatang: 1 }] });
    expect(priced.body.items[0].unitPriceSatang).toBe(2000);
  });

  it('keeps historical snapshots when the menu changes later', async () => {
    const orderId = await openTable('A3');
    const w = await env.as('WAITER');
    await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] });
    await env.db.update(menuItems).set({ name: 'น้ำแร่', priceSatang: 9900 }).where(eq(menuItems.id, water.id));
    const o = (await w.get(`/orders/${orderId}`)).body;
    expect(o.items[0].nameSnapshot).toBe('น้ำเปล่า');
    expect(o.items[0].unitPriceSatang).toBe(2000);
    await env.db.update(menuItems).set({ name: 'น้ำเปล่า', priceSatang: 2000 }).where(eq(menuItems.id, water.id));
  });

  it('ignores duplicate submissions of the same line ids (retries / double taps)', async () => {
    const orderId = await openTable('A4');
    const w = await env.as('WAITER');
    const line = { id: randomUUID(), menuItemId: water.id, qty: 3 };
    const [r1, r2] = await Promise.all([w.post(`/orders/${orderId}/items`, { items: [line] }), w.post(`/orders/${orderId}/items`, { items: [line] })]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const o = (await w.get(`/orders/${orderId}`)).body;
    expect(o.items).toHaveLength(1);
    expect(o.subtotalSatang).toBe(6000);
    // Same line id reused on another bill is refused.
    const other = await openTable('A5');
    expect((await w.post(`/orders/${other}/items`, { items: [line] })).status).toBe(409);
  });

  it('separates draft saving from sending; held courses wait for fire; table status follows', async () => {
    const orderId = await openTable('A6');
    const w = await env.as('WAITER');
    const starter = randomUUID();
    const dessert = randomUUID();
    await w.post(`/orders/${orderId}/items`, {
      items: [
        { id: starter, menuItemId: water.id, qty: 1 },
        { id: dessert, menuItemId: friedRice.id, qty: 1, course: 3, held: true },
      ],
    });
    expect((await tableByName(env, 'A6')).status).toBe('OCCUPIED');
    const s1 = await w.post(`/orders/${orderId}/send`, {});
    expect(s1.body.sent).toBe(1);
    expect((await tableByName(env, 'A6')).status).toBe('WAITING_FOOD');
    const again = await w.post(`/orders/${orderId}/send`, {});
    expect(again.body.sent).toBe(0); // idempotent
    const fire = await w.post(`/orders/${orderId}/send`, { course: 3, includeHeld: true });
    expect(fire.body.sent).toBe(1);
    expect(fire.body.order.items.every((i: any) => i.status === 'SENT')).toBe(true);
  });

  it('edits only drafts; cancelling a sent item needs a reason and permission/approval', async () => {
    const orderId = await openTable('A7');
    const w = await env.as('WAITER');
    const draft = randomUUID();
    const sent = randomUUID();
    await w.post(`/orders/${orderId}/items`, { items: [{ id: sent, menuItemId: water.id, qty: 1 }], send: true });
    await w.post(`/orders/${orderId}/items`, { items: [{ id: draft, menuItemId: water.id, qty: 1 }] });
    expect((await w.patch(`/order-items/${draft}`, { qty: 4 })).body.subtotalSatang).toBe(10000);
    expect((await w.patch(`/order-items/${sent}`, { qty: 4 })).status).toBe(409);
    expect((await w.post(`/order-items/${draft}/cancel`, {})).status).toBe(200); // drafts: no reason
    expect((await w.post(`/order-items/${sent}/cancel`, {})).status).toBe(400);
    expect((await w.post(`/order-items/${sent}/cancel`, { reason: 'ลูกค้าเปลี่ยนใจ' })).status).toBe(403);
    const ok = await w.post(`/order-items/${sent}/cancel`, { reason: 'ลูกค้าเปลี่ยนใจ', approval: { userId: env.userIds.MANAGER, pin: TEST_PIN } });
    expect(ok.status).toBe(200);
    expect(ok.body.grandTotalSatang).toBe(0);
    expect(ok.body.items.find((i: any) => i.id === sent).status).toBe('CANCELLED');
  });

  it('follows order states: bill requested blocks edits until reopened', async () => {
    const orderId = await openTable('A8');
    const w = await env.as('WAITER');
    await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }], send: true });
    expect((await w.post(`/orders/${orderId}/request-bill`)).body.status).toBe('BILL_REQUESTED');
    expect((await tableByName(env, 'A8')).status).toBe('BILL_REQUESTED');
    const blocked = await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] });
    expect(blocked.body.error.code).toBe('ORDER_NOT_EDITABLE');
    expect((await w.post(`/orders/${orderId}/reopen`)).body.status).toBe('OPEN');
  });

  it('void requires reason + manager authority, releases the table and is final', async () => {
    const orderId = await openTable('T1');
    const w = await env.as('WAITER');
    await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }], send: true });
    expect((await w.post(`/orders/${orderId}/void`, {})).status).toBe(400);
    expect((await w.post(`/orders/${orderId}/void`, { reason: 'ลูกค้ายกเลิก' })).status).toBe(403);
    const m = await env.as('MANAGER');
    const r = await m.post(`/orders/${orderId}/void`, { reason: 'ลูกค้ายกเลิก' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('VOIDED');
    expect(r.body.grandTotalSatang).toBe(0);
    expect((await tableByName(env, 'T1')).currentOrderId).toBeNull();
    expect((await m.post(`/orders/${orderId}/void`, { reason: 'อีกครั้ง' })).status).toBe(409);
    expect((await w.post(`/orders/${orderId}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] })).status).toBe(409);
  });

  it('opens takeaway bills with no service charge', async () => {
    const c = await env.as('CASHIER');
    const o = await c.post('/orders', { channel: 'TAKEAWAY', customerName: 'คุณเอ' });
    expect(o.status).toBe(200);
    const r = await c.post(`/orders/${o.body.id}/items`, { items: [{ id: randomUUID(), menuItemId: friedRice.id, qty: 1 }] });
    expect(r.body.serviceChargeSatang).toBe(0);
    expect(r.body.grandTotalSatang).toBe(9630);
    expect((await c.post('/orders', { channel: 'DINE_IN' })).status).toBe(400);
  });

  it('splits lines (incl. partial qty) into a new bill and merges bills back', async () => {
    const orderId = await openTable('T2', 4);
    const c = await env.as('CASHIER');
    const a1 = randomUUID();
    const a2 = randomUUID();
    await c.post(`/orders/${orderId}/items`, {
      items: [
        { id: a1, menuItemId: water.id, qty: 4 },
        { id: a2, menuItemId: friedRice.id, qty: 1 },
      ],
    });
    const split = await c.post(`/orders/${orderId}/split`, { lines: [{ itemId: a1, qty: 1 }] });
    expect(split.status).toBe(200);
    expect(split.body.items[0].qty).toBe(1);
    expect(split.body.splitFromOrderId).toBe(orderId);
    const orig = (await c.get(`/orders/${orderId}`)).body;
    expect(orig.items.find((i: any) => i.id === a1).qty).toBe(3);
    expect(orig.subtotalSatang + split.body.subtotalSatang).toBe(4 * 2000 + 9000);
    const merged = await c.post(`/orders/${orderId}/merge`, { fromOrderId: split.body.id });
    expect(merged.status).toBe(200);
    expect(merged.body.subtotalSatang).toBe(17000);
    expect((await c.get(`/orders/${split.body.id}`)).body.status).toBe('CLOSED');
    // waiters cannot split
    expect((await (await env.as('WAITER')).post(`/orders/${orderId}/split`, { lines: [{ itemId: a2, qty: 1 }] })).status).toBe(403);
  });

  it('enforces branch scoping and permissions', async () => {
    const k = await env.as('KITCHEN');
    expect((await k.post('/orders', { channel: 'TAKEAWAY' })).status).toBe(403);
    const w = await env.as('WAITER');
    expect((await w.get(`/orders/${randomUUID()}`)).status).toBe(404);
  });
});
