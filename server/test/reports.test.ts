import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '../src/lib/time';
import { createTestEnv, itemBySku, tableByName, TEST_PIN, type TestEnv } from './helpers';

let env: TestEnv;
let rice: any; // 90.00
let water: any; // 20.00
const today = businessDate('Asia/Bangkok');
const q = `from=${today}&to=${today}`;
let cashPaymentId: string;

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  rice = await itemBySku(env, 'M001');
  water = await itemBySku(env, 'D004');
  const c = await env.as('CASHIER');
  await c.post('/shifts/open', { openingFloatSatang: 0 });
  const add = async (orderId: string, menuItemId: string, qty: number) => (await c.post(`/orders/${orderId}/items`, { send: true, items: [{ id: randomUUID(), menuItemId, qty }] })).body;

  // 1) Dine-in: 2 × 90 = 180, SC 18, VAT 13.86 → 211.86, cash
  const t = await tableByName(env, 'A1');
  const o1 = (await c.post(`/tables/${t.id}/open`, { guestCount: 3 })).body;
  await add(o1.id, rice.id, 2);
  cashPaymentId = randomUUID();
  await c.post(`/orders/${o1.id}/payments`, { id: cashPaymentId, method: 'CASH', amountSatang: 21186 });
  // 2) Takeaway 1 × 90 → 96.30, split card 50 + cash 46.30
  const o2 = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
  await add(o2.id, rice.id, 1);
  await c.post(`/orders/${o2.id}/payments`, { id: randomUUID(), method: 'CARD', amountSatang: 5000, reference: 'A1' });
  await c.post(`/orders/${o2.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 4630 });
  // 3) Takeaway with 10% discount: 81 + VAT 5.67 → 86.67
  const o3 = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
  await add(o3.id, rice.id, 1);
  await c.post(`/orders/${o3.id}/discounts`, { scope: 'BILL', type: 'PERCENT', value: 1000, reason: 'ลูกค้าประจำ' });
  await c.post(`/orders/${o3.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 8667 });
  // 4) Voided bill (water 20)
  const o4 = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
  await add(o4.id, water.id, 1);
  await c.post(`/orders/${o4.id}/void`, { reason: 'ลูกค้ายกเลิก', approval: { userId: env.userIds.MANAGER, pin: TEST_PIN } });
  // 5) Partial refund of 10 THB on the first bill
  await c.post(`/payments/${cashPaymentId}/refund`, { amountSatang: 1000, reason: 'อาหารช้า', approval: { userId: env.userIds.MANAGER, pin: TEST_PIN } });
  // 6) An open (unpaid) bill must not count as a sale
  const o5 = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
  await add(o5.id, rice.id, 5);
});
afterAll(async () => env.close());

describe('sales report reconciles with the fixture transactions', () => {
  it('totals', async () => {
    const r = (await (await env.as('MANAGER')).get(`/reports/sales?${q}`)).body;
    expect(r.totals).toMatchObject({
      orders: 3,
      grossSatang: 36000,
      discountSatang: 900,
      netSatang: 35100,
      serviceChargeSatang: 1800,
      totalSatang: 21186 + 9630 + 8667,
      refunds: { count: 1, amountSatang: 1000 },
      voids: { count: 1, amountSatang: 2000 },
    });
    expect(r.totals.vatSatang).toBe(1386 + 630 + 567);
    expect(r.daily).toEqual([{ date: today, orders: 3, guests: 5, netSatang: 35100, totalSatang: 39483 }]);
  });

  it('payment methods sum to collections without double counting split bills', async () => {
    const r = (await (await env.as('MANAGER')).get(`/reports/sales?${q}`)).body;
    const by = Object.fromEntries(r.byPayment.map((p: any) => [p.method, p.amountSatang]));
    expect(by).toEqual({ CASH: 21186 - 1000 + 4630 + 8667, CARD: 5000 });
    expect(by.CASH + by.CARD).toBe(r.totals.totalSatang - r.totals.refunds.amountSatang);
    expect(r.byChannel.reduce((a: number, c: any) => a + c.totalSatang, 0)).toBe(r.totals.totalSatang);
    expect(r.hourly.reduce((a: number, h: any) => a + h.orders, 0)).toBe(3);
  });

  it('item performance: quantities from paid bills only', async () => {
    const r = (await (await env.as('MANAGER')).get(`/reports/items?${q}`)).body;
    expect(r.withCost).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: 'ข้าวผัดกุ้ง', qty: 4, revenueSatang: 36000, mixPct: 100 });
    // no recipe → cost is unknown (null), never a fabricated zero
    expect(r.items[0].costSatang).toBeNull();
    expect(r.items[0].menuClass).toBeNull();
  });

  it('staff controls attribute voids, discounts and refunds', async () => {
    const r = (await (await env.as('MANAGER')).get(`/reports/staff?${q}`)).body;
    expect(r.voids).toEqual([{ name: 'cashier', count: 1, amountSatang: 2000 }]);
    expect(r.discounts[0]).toMatchObject({ givenBy: 'cashier', count: 1, amountSatang: 900 });
    expect(r.refunds[0]).toMatchObject({ name: 'cashier', approvedBy: 'manager', amountSatang: 1000 });
  });

  it('tax summary splits base and VAT and lists receipt numbers', async () => {
    const r = (await (await env.as('MANAGER')).get(`/reports/tax?${q}`)).body;
    expect(r.days[0]).toMatchObject({ receipts: 3, vatSatang: 2583, totalSatang: 39483, taxableBaseSatang: 39483 - 2583 });
    expect(r.days[0].firstNo).toMatch(/^T1/);
    expect(r.disclaimer).toBeTruthy();
  });

  it('dashboard shows today and live floor state', async () => {
    const r = (await (await env.as('MANAGER')).get('/reports/dashboard')).body;
    expect(r.now.totalSatang).toBe(39483);
    expect(r.live.openOrders).toBe(1);
    expect(r.topItems[0].name).toBe('ข้าวผัดกุ้ง');
  });

  it('restricts sensitive reports by permission and branch', async () => {
    expect((await (await env.as('WAITER')).get(`/reports/sales?${q}`)).status).toBe(403);
    expect((await (await env.as('CASHIER')).get(`/reports/costs?${q}`)).status).toBe(403);
    expect((await (await env.as('CASHIER')).get(`/reports/staff?${q}`)).status).toBe(403);
    expect((await (await env.as('MANAGER')).get(`/reports/sales?${q}&branches=${randomUUID()}`)).status).toBe(403);
    expect((await (await env.as('MANAGER')).get(`/reports/sales?from=${today}&to=2000-01-01`)).status).toBe(400);
  });

  it('exports CSV with formula-injection protection', async () => {
    const m = await env.as('MANAGER');
    const cat = (await m.get('/menu/admin')).body.categories[0].id;
    const evil = (await m.post('/menu/items', { categoryId: cat, name: '=HYPERLINK("http://evil")', priceSatang: 100 })).body;
    const c = await env.as('CASHIER');
    const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
    await c.post(`/orders/${o.id}/items`, { send: true, items: [{ id: randomUUID(), menuItemId: evil.id, qty: 1 }] });
    await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 107 });
    const r = await env.app.inject({ method: 'GET', url: `/api/reports/export?report=items&${q}`, headers: { cookie: m.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(r.body).not.toMatch(/(^|,)=HYPERLINK/m);
    expect((await (await env.as('CASHIER')).get(`/reports/export?report=items&${q}`)).status).toBe(403);
  });
});
