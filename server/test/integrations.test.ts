import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orders, payments } from '../src/db/schema';
import { encodeTis620, visualWidth } from '../src/integrations/escpos';
import { createLineNotifier } from '../src/integrations/line';
import { createOpnGateway, type GatewayCharge, type PaymentGateway } from '../src/integrations/opn';
import { createTestEnv, itemBySku, type TestEnv } from './helpers';

describe('ESC/POS encoding', () => {
  it('maps Thai to TIS-620 and measures printed width without combining marks', () => {
    expect(encodeTis620('ก')).toEqual([0xa1]);
    expect(encodeTis620('A๙')).toEqual([0x41, 0xf9]);
    expect(encodeTis620('€')).toEqual([0x3f]);
    expect(visualWidth('ข้าว')).toBe(3); // ้ is a combining tone mark
  });
});

describe('LINE notifier', () => {
  it('is disabled without credentials and posts when configured', async () => {
    expect(createLineNotifier({}).enabled).toBe(false);
    const calls: any[] = [];
    const n = createLineNotifier({ LINE_CHANNEL_ACCESS_TOKEN: 'tkn', LINE_NOTIFY_TO: 'U1' }, async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    });
    expect(await n.push('ทดสอบ')).toBe(true);
    expect(calls[0].init.headers.Authorization).toBe('Bearer tkn');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ to: 'U1', messages: [{ type: 'text', text: 'ทดสอบ' }] });
  });
});

describe('Opn webhook signature', () => {
  const secret = Buffer.from('super-secret-signing-key').toString('base64');
  const gw = createOpnGateway({ OPN_SECRET_KEY: 'skey_test', OPN_WEBHOOK_SECRET: secret, OPN_API_BASE: 'http://x' });
  const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
    'omise-signature': createHmac('sha256', Buffer.from(secret, 'base64')).update(`${ts}.${body}`).digest('hex'),
    'omise-signature-timestamp': String(ts),
  });
  it('accepts a valid signature and rejects tampering or stale timestamps', () => {
    const body = '{"id":"evnt_1"}';
    expect(gw.verifyWebhook(Buffer.from(body), sign(body))).toBe(true);
    expect(gw.verifyWebhook(Buffer.from('{"id":"evnt_2"}'), sign(body))).toBe(false);
    expect(gw.verifyWebhook(Buffer.from(body), sign(body, Math.floor(Date.now() / 1000) - 3600))).toBe(false);
    expect(gw.verifyWebhook(Buffer.from(body), {})).toBe(false);
  });
});

describe('integrations through the API', () => {
  let env: TestEnv;
  let printerServer: Server;
  let printerPort = 0;
  const received: Buffer[] = [];
  const charges = new Map<string, GatewayCharge>();
  const webhookSecret = Buffer.from('opn-webhook-secret').toString('base64');
  const real = createOpnGateway({ OPN_SECRET_KEY: 'k', OPN_WEBHOOK_SECRET: webhookSecret, OPN_API_BASE: 'http://unused' });
  // Fake gateway: real signature verification, in-memory charges instead of HTTP calls.
  const gateway: PaymentGateway = {
    name: 'opn',
    enabled: true,
    async createPromptPayCharge(amountSatang, metadata) {
      const c = { id: `chrg_${randomUUID().replace(/-/g, '')}`, status: 'pending', amountSatang, qrImageUrl: 'https://example.invalid/qr.png', metadata };
      charges.set(c.id, c);
      return c;
    },
    async getCharge(id) {
      return charges.get(id)!;
    },
    verifyWebhook: real.verifyWebhook,
  };
  const signed = (obj: unknown) => {
    const body = JSON.stringify(obj);
    const ts = Math.floor(Date.now() / 1000);
    return { body, headers: { 'content-type': 'application/json', 'omise-signature': createHmac('sha256', Buffer.from(webhookSecret, 'base64')).update(`${ts}.${body}`).digest('hex'), 'omise-signature-timestamp': String(ts) } };
  };

  beforeAll(async () => {
    printerServer = createServer((s) => {
      const chunks: Buffer[] = [];
      s.on('data', (d) => chunks.push(Buffer.from(d)));
      s.on('end', () => received.push(Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => printerServer.listen(0, '127.0.0.1', () => r()));
    printerPort = (printerServer.address() as any).port;
    env = await createTestEnv({ demo: true, env: { DELIVERY_WEBHOOK_SECRET: 'delivery-secret' }, integrations: { gateway } });
    await (await env.as('CASHIER')).post('/shifts/open', { openingFloatSatang: 0 });
  });
  afterAll(async () => {
    await env.close();
    printerServer.close();
  });

  it('registers a LAN printer and prints a Thai receipt over TCP 9100 (with drawer kick)', async () => {
    const m = await env.as('MANAGER');
    const p = await m.post('/devices/printers', { name: 'เครื่องพิมพ์เคาน์เตอร์', config: { host: '127.0.0.1', port: printerPort, role: 'RECEIPT', openDrawer: true } });
    expect(p.status).toBe(200);
    expect((await m.post(`/devices/${p.body.id}/test-print`)).status).toBe(200);
    const c = await env.as('CASHIER');
    const rice = await itemBySku(env, 'M001');
    const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
    const withItems = (await c.post(`/orders/${o.id}/items`, { send: true, items: [{ id: randomUUID(), menuItemId: rice.id, qty: 1 }] })).body;
    await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: withItems.grandTotalSatang, tenderedSatang: 10000 });
    const before = received.length;
    expect((await c.post(`/orders/${o.id}/print`, { kind: 'receipt', openDrawer: true })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const doc = received[before];
    expect(doc.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(doc.includes(Buffer.from(encodeTis620('ข้าวผัดกุ้ง')))).toBe(true);
    expect(doc.includes(Buffer.from([0x1b, 0x70, 0x00]))).toBe(true); // drawer kick
    expect((await (await env.as('WAITER')).post(`/orders/${o.id}/print`, { kind: 'receipt', openDrawer: true })).status).toBe(403);
  });

  it('reports a clear error when the printer is unreachable', async () => {
    const m = await env.as('MANAGER');
    const dead = await m.post('/devices/printers', { name: 'ปิดอยู่', config: { host: '127.0.0.1', port: 1, role: 'RECEIPT' } });
    const r = await m.post(`/devices/${dead.body.id}/test-print`);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('PRINTER_ERROR');
  });

  it('PromptPay via gateway: pending until a verified webhook confirms; replays are ignored', async () => {
    const c = await env.as('CASHIER');
    const water = await itemBySku(env, 'D004');
    const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
    const bill = (await c.post(`/orders/${o.id}/items`, { send: true, items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] })).body;
    const pid = randomUUID();
    const ch = await c.post(`/orders/${o.id}/payments/gateway`, { paymentId: pid, amountSatang: bill.grandTotalSatang });
    expect(ch.status).toBe(200);
    expect(ch.body.status).toBe('PENDING_CONFIRMATION');
    // forged webhook is rejected
    const forged = await env.app.inject({ method: 'POST', url: '/api/webhooks/payments/opn', payload: JSON.stringify({ id: 'evnt_x', key: 'charge.complete', data: { id: ch.body.providerRef } }), headers: { 'content-type': 'application/json' } });
    expect(forged.statusCode).toBe(401);
    // a signed webhook for a charge that is NOT actually paid does not confirm anything
    const early = signed({ id: 'evnt_1', key: 'charge.complete', data: { id: ch.body.providerRef, status: 'successful' } });
    await env.app.inject({ method: 'POST', url: '/api/webhooks/payments/opn', payload: early.body, headers: early.headers });
    expect((await env.db.select().from(payments).where(eq(payments.id, pid)))[0].status).toBe('PENDING_CONFIRMATION');
    // provider marks it paid → next event confirms and settles the bill
    charges.get(ch.body.providerRef)!.status = 'successful';
    const ok = signed({ id: 'evnt_2', key: 'charge.complete', data: { id: ch.body.providerRef } });
    const r = await env.app.inject({ method: 'POST', url: '/api/webhooks/payments/opn', payload: ok.body, headers: ok.headers });
    expect(r.statusCode).toBe(200);
    expect((await env.db.select().from(orders).where(eq(orders.id, o.id)))[0].status).toBe('PAID');
    const replay = await env.app.inject({ method: 'POST', url: '/api/webhooks/payments/opn', payload: ok.body, headers: ok.headers });
    expect(replay.json().duplicate).toBe(true);
    expect((await env.db.select().from(payments).where(eq(payments.orderId, o.id)))).toHaveLength(1);
  });

  it('delivery webhook: HMAC-verified, idempotent, lands in POS and KDS', async () => {
    const body = JSON.stringify({ eventId: 'grab-evt-1', branchCode: 'T1', externalOrderId: 'GF-123', customerName: 'Grab คุณบี', items: [{ sku: 'M001', qty: 2 }] });
    const sig = createHmac('sha256', 'delivery-secret').update(body).digest('hex');
    const bad = await env.app.inject({ method: 'POST', url: '/api/webhooks/delivery/GRAB', payload: body, headers: { 'content-type': 'application/json', 'x-signature': '00' } });
    expect(bad.statusCode).toBe(401);
    const r = await env.app.inject({ method: 'POST', url: '/api/webhooks/delivery/GRAB', payload: body, headers: { 'content-type': 'application/json', 'x-signature': sig } });
    expect(r.statusCode).toBe(200);
    const again = await env.app.inject({ method: 'POST', url: '/api/webhooks/delivery/GRAB', payload: body, headers: { 'content-type': 'application/json', 'x-signature': sig } });
    expect(again.json().duplicate).toBe(true);
    const k = await env.as('KITCHEN');
    const hot = (await k.get('/kds?station=HOT')).body.tickets.find((t: any) => t.orderId === r.json().orderId);
    expect(hot.channel).toBe('GRAB');
    expect(hot.items[0].qty).toBe(2);
  });

  it('low stock creates an in-app notification for inventory users only', async () => {
    const m = await env.as('MANAGER');
    const ing = (await m.post('/inventory/ingredients', { name: 'มะนาว', baseUnit: 'pcs', reorderPoint: '10' })).body.id;
    const s = await env.as('STOREKEEPER');
    await s.post('/inventory/receive', { lines: [{ ingredientId: ing, qty: '12', unit: 'pcs', unitCostSatang: 300 }] });
    await s.post('/inventory/issue', { reason: 'ใช้ทำน้ำ', lines: [{ ingredientId: ing, qty: '5', unit: 'pcs' }] });
    await new Promise((r) => setTimeout(r, 400));
    const mine = (await s.get('/notifications')).body.notifications;
    expect(mine.some((n: any) => n.kind === 'stock_low' && n.title.includes('มะนาว'))).toBe(true);
    const waiter = (await (await env.as('WAITER')).get('/notifications')).body.notifications;
    expect(waiter.some((n: any) => n.kind === 'stock_low')).toBe(false);
    await s.post('/notifications/read', { ids: [mine[0].id] });
    expect((await s.get('/notifications')).body.notifications[0].read).toBe(true);
  });

  it('offline-recorded cash payments are accepted and flagged; non-cash offline is refused', async () => {
    const c = await env.as('CASHIER');
    const water = await itemBySku(env, 'D004');
    const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
    const bill = (await c.post(`/orders/${o.id}/items`, { send: true, items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] })).body;
    const at = new Date(Date.now() - 60_000).toISOString();
    expect((await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CARD', amountSatang: 100, reference: 'x', offlineRecordedAt: at })).status).toBe(400);
    const r = await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: bill.grandTotalSatang, offlineRecordedAt: at });
    expect(r.body.status).toBe('PAID');
    expect(r.body.payments[0].offlineRecordedAt).not.toBeNull();
  });
});
