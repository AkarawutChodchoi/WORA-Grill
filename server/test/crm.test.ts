import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customers, loyaltyTransactions } from '../src/db/schema';
import { createTestEnv, itemBySku, type TestEnv } from './helpers';

let env: TestEnv;
let rice: any; // 90.00
let water: any; // 20.00
let customerId: string;

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  rice = await itemBySku(env, 'M001');
  water = await itemBySku(env, 'D004');
  const owner = await env.as('OWNER');
  // loyalty: 1 point per 100 THB, 1 point = 1 THB
  await owner.put('/settings/org', { name: 'Test Org', settings: { loyalty: { enabled: true, pointsPer100Baht: 1, pointValueSatang: 100, expiryMonths: 0, tiers: [], birthdayCouponPromotionId: null } } });
  await (await env.as('CASHIER')).post('/shifts/open', { openingFloatSatang: 0 });
});
afterAll(async () => env.close());

async function takeaway(items: { menuItemId: string; qty: number }[]) {
  const c = await env.as('CASHIER');
  const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
  return (await c.post(`/orders/${o.id}/items`, { send: true, items: items.map((i) => ({ id: randomUUID(), ...i })) })).body;
}

describe('customers and privacy', () => {
  it('creates a member with consent; duplicate phone refused', async () => {
    const c = await env.as('CASHIER');
    const r = await c.post('/customers', { name: 'คุณสมศรี', phone: '081-234-5678', consentMarketing: true, birthDate: '1990-05-01' });
    expect(r.status).toBe(200);
    customerId = r.body.id;
    expect(r.body.phone).toBe('0812345678');
    expect(r.body.consentAt).not.toBeNull();
    expect((await c.post('/customers', { name: 'ซ้ำ', phone: '0812345678' })).status).toBe(409);
  });

  it('masks phone numbers in lists; waiters and kitchen cannot read customers', async () => {
    const c = await env.as('CASHIER');
    const list = (await c.get('/customers?q=สมศรี')).body.customers;
    expect(list[0].phone).toBe('081-xxx-5678');
    expect((await c.get('/customers/lookup?phone=0812345678')).body.customer.id).toBe(customerId);
    expect((await (await env.as('WAITER')).get('/customers')).status).toBe(403);
    expect((await (await env.as('KITCHEN')).get(`/customers/${customerId}`)).status).toBe(403);
  });

  it('PII export and anonymisation need the PDPA permission', async () => {
    expect((await (await env.as('MANAGER')).get(`/customers/${customerId}/export`)).status).toBe(403);
    expect((await (await env.as('OWNER')).get(`/customers/${customerId}/export`)).body.customer.phone).toBe('0812345678');
  });
});

describe('loyalty', () => {
  it('earns points once when a member bill is paid', async () => {
    const o = await takeaway([{ menuItemId: rice.id, qty: 3 }]); // 270 + VAT = 288.90
    const c = await env.as('CASHIER');
    await c.post(`/orders/${o.id}/customer`, { customerId });
    const paid = await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: o.grandTotalSatang });
    expect(paid.body.status).toBe('PAID');
    const [m] = await env.db.select().from(customers).where(eq(customers.id, customerId));
    expect(m.pointsBalance).toBe(2);
    expect(m.visitCount).toBe(1);
    const tx = await env.db.select().from(loyaltyTransactions).where(eq(loyaltyTransactions.orderId, o.id));
    expect(tx).toHaveLength(1);
  });

  it('redeems points as a payment and blocks overdraw', async () => {
    const o = await takeaway([{ menuItemId: water.id, qty: 1 }]); // 21.40
    const c = await env.as('CASHIER');
    expect((await c.post(`/orders/${o.id}/redeem-points`, { paymentId: randomUUID(), points: 1 })).body.error.code).toBe('NO_CUSTOMER');
    await c.post(`/orders/${o.id}/customer`, { customerId });
    expect((await c.post(`/orders/${o.id}/redeem-points`, { paymentId: randomUUID(), points: 5 })).body.error.code).toBe('INSUFFICIENT_POINTS');
    const pid = randomUUID();
    const r = await c.post(`/orders/${o.id}/redeem-points`, { paymentId: pid, points: 2 });
    expect(r.body.paidSatang).toBe(200);
    await c.post(`/orders/${o.id}/redeem-points`, { paymentId: pid, points: 2 }); // replay
    const [m] = await env.db.select().from(customers).where(eq(customers.id, customerId));
    expect(m.pointsBalance).toBe(0);
  });

  it('manual adjustments need loyalty.adjust', async () => {
    expect((await (await env.as('CASHIER')).post(`/customers/${customerId}/points`, { points: 100, reason: 'ของขวัญ' })).status).toBe(403);
    expect((await (await env.as('MANAGER')).post(`/customers/${customerId}/points`, { points: 100, reason: 'ชดเชยรออาหารนาน' })).status).toBe(200);
  });
});

describe('promotions', () => {
  let pct: string;
  let minSpend: string;
  let bogo: string;

  it('managers create promotions; invalid rules are rejected', async () => {
    const m = await env.as('MANAGER');
    expect((await m.post('/promotions', { name: 'bad', type: 'PERCENT_BILL', value: 20000 })).status).toBe(400);
    expect((await (await env.as('CASHIER')).post('/promotions', { name: 'x', type: 'AMOUNT_BILL', value: 100 })).status).toBe(403);
    pct = (await m.post('/promotions', { name: 'ลด 10%', type: 'PERCENT_BILL', value: 1000, usageLimitTotal: 2 })).body.id;
    minSpend = (await m.post('/promotions', { name: 'ครบ 200 ลด 50', type: 'AMOUNT_BILL', value: 5000, conditions: { minSpendSatang: 20000 }, stackable: true })).body.id;
    bogo = (await m.post('/promotions', { name: 'น้ำ 2 แถม 1', type: 'BUY_X_GET_Y', value: 0, conditions: { menuItemIds: [water.id], buyQty: 2, getQty: 1 }, stackable: true })).body.id;
  });

  it('applies eligible promotions with server-side checks and stacking rules', async () => {
    const o = await takeaway([
      { menuItemId: rice.id, qty: 2 },
      { menuItemId: water.id, qty: 3 },
    ]); // 240
    const c = await env.as('CASHIER');
    const b = await c.post(`/orders/${o.id}/promotions`, { promotionId: bogo });
    expect(b.body.amountSatang).toBe(2000);
    const ms = await c.post(`/orders/${o.id}/promotions`, { promotionId: minSpend });
    expect(ms.body.amountSatang).toBe(5000);
    // non-stackable promo cannot join stacked ones
    expect((await c.post(`/orders/${o.id}/promotions`, { promotionId: pct })).body.error.code).toBe('PROMO_NOT_ELIGIBLE');
    expect((await c.post(`/orders/${o.id}/promotions`, { promotionId: minSpend })).body.error.code).toBe('PROMO_NOT_ELIGIBLE');
    expect(ms.body.order.discounts.filter((d: any) => d.promotionId)).toHaveLength(2);
  });

  it('re-checks promotions at payment when the bill changed', async () => {
    const o = await takeaway([{ menuItemId: rice.id, qty: 3 }]); // 270
    const c = await env.as('CASHIER');
    await c.post(`/orders/${o.id}/promotions`, { promotionId: minSpend });
    const detail = (await c.get(`/orders/${o.id}`)).body;
    // cancel two dishes → below the 200 THB minimum
    const line = detail.items[0];
    await c.patch(`/order-items/${line.id}`, {}); // no-op
    await c.post(`/order-items/${line.id}/cancel`, { reason: 'ลูกค้ายกเลิก', approval: { userId: env.userIds.MANAGER, pin: '2468' } });
    const add = await c.post(`/orders/${o.id}/items`, { send: true, items: [{ id: randomUUID(), menuItemId: rice.id, qty: 1 }] });
    const pay = await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: add.body.grandTotalSatang });
    expect(pay.body.error.code).toBe('PROMOTIONS_CHANGED');
    const after = (await c.get(`/orders/${o.id}`)).body;
    expect(after.discounts.filter((d: any) => d.promotionId)).toHaveLength(0);
    expect(after.grandTotalSatang).toBe(9630);
  });

  it('usage limits count across bills; voiding a bill releases the use', async () => {
    const c = await env.as('CASHIER');
    const o1 = await takeaway([{ menuItemId: rice.id, qty: 1 }]);
    const o2 = await takeaway([{ menuItemId: rice.id, qty: 1 }]);
    const o3 = await takeaway([{ menuItemId: rice.id, qty: 1 }]);
    expect((await c.post(`/orders/${o1.id}/promotions`, { promotionId: pct })).status).toBe(200);
    expect((await c.post(`/orders/${o2.id}/promotions`, { promotionId: pct })).status).toBe(200);
    expect((await c.post(`/orders/${o3.id}/promotions`, { promotionId: pct })).body.error.code).toBe('PROMO_NOT_ELIGIBLE');
    await (await env.as('MANAGER')).post(`/orders/${o2.id}/void`, { reason: 'ทดสอบยกเลิก' });
    expect((await c.post(`/orders/${o3.id}/promotions`, { promotionId: pct })).status).toBe(200);
  });

  it('single-use coupons cannot be redeemed twice', async () => {
    const m = await env.as('MANAGER');
    const promo = (await m.post('/promotions', { name: 'คูปอง 30 บาท', type: 'AMOUNT_BILL', value: 3000, requiresCoupon: true, stackable: true })).body.id;
    const [cp] = (await m.post(`/promotions/${promo}/coupons`, { count: 1 })).body.coupons;
    const c = await env.as('CASHIER');
    const o1 = await takeaway([{ menuItemId: rice.id, qty: 1 }]);
    const o2 = await takeaway([{ menuItemId: rice.id, qty: 1 }]);
    expect((await c.post(`/orders/${o1.id}/promotions`, { promotionId: promo })).body.error.code).toBe('PROMO_INVALID');
    expect((await c.post(`/orders/${o1.id}/promotions`, { code: cp.code.toLowerCase() })).status).toBe(200);
    expect((await c.post(`/orders/${o2.id}/promotions`, { code: cp.code })).body.error.code).toBe('PROMO_INVALID');
    // removing the discount returns the coupon
    const d = (await c.get(`/orders/${o1.id}`)).body.discounts.find((x: any) => x.couponCode);
    await c.del(`/discounts/${d.id}`);
    expect((await c.post(`/orders/${o2.id}/promotions`, { code: cp.code })).status).toBe(200);
  });

  it('anonymised customers keep transactions but lose personal data', async () => {
    const o = await env.as('OWNER');
    expect((await o.post(`/customers/${customerId}/anonymize`, { reason: 'ลูกค้าขอลบข้อมูล' })).status).toBe(200);
    const [m] = await env.db.select().from(customers).where(eq(customers.id, customerId));
    expect(m.phone).toBeNull();
    expect(m.name).toBe('ลบข้อมูลตามคำขอ');
    const tx = await env.db.select().from(loyaltyTransactions).where(eq(loyaltyTransactions.customerId, customerId));
    expect(tx.length).toBeGreaterThan(0);
  });
});
