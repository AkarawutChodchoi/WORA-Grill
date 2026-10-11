// Regression tests for findings of the independent security review (Prompt 17).
import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, customers, orders, roles, rolePermissions, userRoles, users, webhookEvents } from '../src/db/schema';
import { hashSecret } from '../src/lib/crypto';
import type { PaymentGateway } from '../src/integrations/opn';
import { Client, createTestEnv, itemBySku, TEST_PASSWORD, TEST_PIN, type TestEnv } from './helpers';

let env: TestEnv;
let water: any;
let rice: any;
let failGetCharge = true;
const gateway: PaymentGateway = {
  name: 'opn',
  enabled: true,
  createPromptPayCharge: async (amountSatang) => ({ id: `chrg_${randomUUID().replace(/-/g, '')}`, status: 'pending', amountSatang, qrImageUrl: null, metadata: {} }),
  getCharge: async (id) => {
    if (failGetCharge) throw new Error('provider timeout');
    return { id, status: 'successful', amountSatang: 2140, qrImageUrl: null, metadata: {} };
  },
  verifyWebhook: () => true,
};

beforeAll(async () => {
  env = await createTestEnv({ demo: true, integrations: { gateway }, env: { DELIVERY_WEBHOOK_SECRET: 'sec' } });
  water = await itemBySku(env, 'D004');
  rice = await itemBySku(env, 'M001');
  await (await env.as('CASHIER')).post('/shifts/open', { openingFloatSatang: 0 });
});
afterAll(async () => env.close());

async function bill(items: { menuItemId: string; qty: number }[]) {
  const c = await env.as('CASHIER');
  const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
  return (await c.post(`/orders/${o.id}/items`, { send: true, items: items.map((i) => ({ id: randomUUID(), ...i })) })).body;
}

describe('review fixes', () => {
  it('split cannot move lines into an existing (e.g. voided) bill', async () => {
    const victim = await bill([{ menuItemId: water.id, qty: 1 }]);
    await (await env.as('MANAGER')).post(`/orders/${victim.id}/void`, { reason: 'ทดสอบ' });
    const o = await bill([
      { menuItemId: water.id, qty: 1 },
      { menuItemId: rice.id, qty: 1 },
    ]);
    const r = await (await env.as('CASHIER')).post(`/orders/${o.id}/split`, { newOrderId: victim.id, lines: [{ itemId: o.items[0].id, qty: 1 }] });
    expect(r.status).toBe(409);
    expect((await (await env.as('CASHIER')).get(`/orders/${o.id}`)).body.items.filter((i: any) => i.status !== 'CANCELLED')).toHaveLength(2);
  });

  it('a user manager cannot reset credentials of someone with more permissions', async () => {
    const [role] = await env.db.insert(roles).values({ organizationId: env.orgId, code: 'AUDITOR', name: 'Auditor' }).returning();
    await env.db.insert(rolePermissions).values([{ roleId: role.id, permission: 'customer.export_pii' }]);
    const [u] = await env.db.insert(users).values({ organizationId: env.orgId, name: 'auditor', email: 'aud@test.local', passwordHash: await hashSecret(TEST_PASSWORD) }).returning();
    await env.db.insert(userRoles).values({ userId: u.id, roleId: role.id, branchId: env.branchId });
    const m = await env.as('MANAGER');
    expect((await m.patch(`/users/${u.id}`, { password: 'manager-chosen-pass' })).status).toBe(403);
    expect((await m.patch(`/users/${env.userIds.WAITER}`, { pin: '9753' })).status).toBe(200);
  });

  it('approval PINs lock after repeated failures and failures are audited', async () => {
    const o = await bill([{ menuItemId: water.id, qty: 1 }]);
    const c = await env.as('CASHIER');
    for (let i = 0; i < 5; i++) await c.post(`/orders/${o.id}/void`, { reason: 'ลองเดา PIN', approval: { userId: env.userIds.OWNER, pin: String(1000 + i) } });
    const locked = await c.post(`/orders/${o.id}/void`, { reason: 'ลองเดา PIN', approval: { userId: env.userIds.OWNER, pin: TEST_PIN } });
    expect(locked.status).toBe(429);
    await new Promise((r) => setTimeout(r, 200));
    const [owner] = await env.db.select().from(users).where(eq(users.id, env.userIds.OWNER));
    expect(owner.lockedUntil).not.toBeNull(); // persists even though each attempt's transaction rolled back
    const audits = await env.db.select().from(auditLogs).where(eq(auditLogs.action, 'approval.pin_failed'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    await env.db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, env.userIds.OWNER));
  });

  it('pending payments block void/merge/discount; gateway charges reserve the amount', async () => {
    const o = await bill([{ menuItemId: water.id, qty: 1 }]); // 21.40
    const c = await env.as('CASHIER');
    const [r1, r2] = await Promise.all([
      c.post(`/orders/${o.id}/payments/gateway`, { paymentId: randomUUID(), amountSatang: 2140 }),
      c.post(`/orders/${o.id}/payments/gateway`, { paymentId: randomUUID(), amountSatang: 2140 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 422]);
    expect((await (await env.as('MANAGER')).post(`/orders/${o.id}/void`, { reason: 'ทดสอบ' })).body.error.code).toBe('HAS_PAYMENTS');
    expect((await c.post(`/orders/${o.id}/discounts`, { scope: 'BILL', type: 'PERCENT', value: 500, reason: 'ทดสอบ' })).body.error.code).toBe('HAS_PAYMENTS');
    const other = await bill([{ menuItemId: water.id, qty: 1 }]);
    expect((await c.post(`/orders/${other.id}/merge`, { fromOrderId: o.id })).body.error.code).toBe('HAS_PAYMENTS');

    // A webhook whose processing fails is retried by the provider and then succeeds.
    const ok = r1.status === 200 ? r1 : r2;
    const payload = JSON.stringify({ id: 'evnt_retry', key: 'charge.complete', data: { id: ok.body.providerRef } });
    const send = () => env.app.inject({ method: 'POST', url: '/api/webhooks/payments/opn', payload, headers: { 'content-type': 'application/json' } });
    expect((await send()).statusCode).toBe(500);
    failGetCharge = false;
    expect((await send()).statusCode).toBe(200);
    expect((await env.db.select().from(orders).where(eq(orders.id, o.id)))[0].status).toBe('PAID');
    const [ev] = await env.db.select().from(webhookEvents).where(eq(webhookEvents.eventId, 'evnt_retry'));
    expect(ev.status).toBe('PROCESSED');
    expect((await send()).json().duplicate).toBe(true);
  });

  it('a failed delivery order can be redelivered after the menu is fixed', async () => {
    const body = JSON.stringify({ eventId: 'gf-1', branchCode: 'T1', externalOrderId: 'X1', items: [{ sku: 'NOPE', qty: 1 }] });
    const sig = createHmac('sha256', 'sec').update(body).digest('hex');
    const post = () => env.app.inject({ method: 'POST', url: '/api/webhooks/delivery/GRAB', payload: body, headers: { 'content-type': 'application/json', 'x-signature': sig } });
    expect((await post()).statusCode).toBe(422);
    const [ev] = await env.db.select().from(webhookEvents).where(and(eq(webhookEvents.provider, 'delivery:GRAB'), eq(webhookEvents.eventId, 'gf-1')));
    expect(ev.status).toBe('FAILED');
    expect((await post()).json().duplicate).toBeUndefined(); // reprocessed, not swallowed
  });

  it('supplier returns are capped by received minus already-returned quantity; duplicate lines refused', async () => {
    const m = await env.as('MANAGER');
    const ing = (await m.post('/inventory/ingredients', { name: 'ซอส', baseUnit: 'ml' })).body.id;
    const sup = (await m.post('/purchasing/suppliers', { name: 'ซัพ', items: [] })).body.id;
    const s = await env.as('STOREKEEPER');
    const gr = await s.post('/purchasing/receipts', { id: randomUUID(), supplierId: sup, lines: [{ ingredientId: ing, unit: 'ml', deliveredQty: '1000', unitPriceSatang: 10 }] });
    expect(gr.status).toBe(200);
    const ret = (qty: string) => s.post('/purchasing/returns', { id: randomUUID(), supplierId: sup, grId: gr.body.id, reason: 'ของเสีย', lines: [{ ingredientId: ing, qty, unit: 'ml' }] });
    expect((await ret('600')).status).toBe(200);
    expect((await ret('600')).body.error.code).toBe('OVER_RETURN');
    const dup = await s.post('/purchasing/returns', { id: randomUUID(), supplierId: sup, grId: gr.body.id, reason: 'ซ้ำ', lines: [{ ingredientId: ing, qty: '1', unit: 'ml' }, { ingredientId: ing, qty: '1', unit: 'ml' }] });
    expect(dup.status).toBe(400);
  });

  it('manual stock receive with a client id is idempotent', async () => {
    const m = await env.as('MANAGER');
    const ing = (await m.post('/inventory/ingredients', { name: 'เกลือ', baseUnit: 'g' })).body.id;
    const s = await env.as('STOREKEEPER');
    const body = { id: randomUUID(), lines: [{ ingredientId: ing, qty: '100', unit: 'g', unitCostSatang: 1 }] };
    await s.post('/inventory/receive', body);
    await s.post('/inventory/receive', body);
    const list = (await m.get('/inventory/ingredients')).body.ingredients;
    expect(Number(list.find((i: any) => i.id === ing).onHand)).toBe(100);
  });

  it('revoking a terminal ends PIN sessions on it', async () => {
    const m = await env.as('MANAGER');
    const pair = await m.post('/auth/terminal', { name: 'POS X', kind: 'POS' });
    const device = new Client(env.app, m.cookie.split('; ').find((c) => c.startsWith('rms_device='))!);
    await device.post('/auth/pin-login', { userId: env.userIds.KITCHEN, pin: TEST_PIN });
    expect((await device.get('/auth/me')).status).toBe(200);
    await m.del(`/devices/${pair.body.id}`);
    expect((await device.get('/auth/me')).status).toBe(401);
  });

  it('refunds claw back loyalty points, even into a negative balance', async () => {
    const owner = await env.as('OWNER');
    await owner.put('/settings/org', { name: 'Test Org', settings: { loyalty: { enabled: true, pointsPer100Baht: 10, pointValueSatang: 100, expiryMonths: 0, tiers: [], birthdayCouponPromotionId: null } } });
    const c = await env.as('CASHIER');
    const cust = (await c.post('/customers', { name: 'แต้ม', phone: '0899999999' })).body.id;
    const o = await bill([{ menuItemId: rice.id, qty: 2 }]); // 192.60 → 19 points
    await c.post(`/orders/${o.id}/customer`, { customerId: cust });
    const pid = randomUUID();
    await c.post(`/orders/${o.id}/payments`, { id: pid, method: 'CASH', amountSatang: o.grandTotalSatang });
    const bal = async () => (await env.db.select().from(customers).where(eq(customers.id, cust)))[0].pointsBalance;
    expect(await bal()).toBe(19);
    // spend the points elsewhere, then refund the whole bill
    const o2 = await bill([{ menuItemId: water.id, qty: 1 }]);
    await c.post(`/orders/${o2.id}/customer`, { customerId: cust });
    await c.post(`/orders/${o2.id}/redeem-points`, { paymentId: randomUUID(), points: 19 });
    const appr = { userId: env.userIds.MANAGER, pin: TEST_PIN };
    await c.post(`/payments/${pid}/refund`, { amountSatang: 9630, reason: 'คืนครึ่ง', approval: appr });
    expect(await bal()).toBe(-10); // ceil(19 × 96.30 / 192.60)
    await c.post(`/payments/${pid}/refund`, { amountSatang: o.grandTotalSatang - 9630, reason: 'คืนที่เหลือ', approval: appr });
    expect(await bal()).toBe(-19);
  });
});
