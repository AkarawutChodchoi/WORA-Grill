import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branches } from '../src/db/schema';
import { createTestEnv, itemBySku, tableByName, TEST_PIN, type TestEnv } from './helpers';

let env: TestEnv;
let rice: any;
let water: any;

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  rice = await itemBySku(env, 'M001'); // 90.00
  water = await itemBySku(env, 'D004'); // 20.00
  await env.db
    .update(branches)
    .set({ taxId: '0105500000000', settings: { enabledPaymentMethods: ['CASH', 'CARD', 'PROMPTPAY', 'TRANSFER'], promptPayId: '0812345678' } as never })
    .where(eq(branches.id, env.branchId));
});
afterAll(async () => env.close());

/** Takeaway bill (no service charge): 90 + 2×20 = 130 → VAT 9.10 → 139.10 */
async function takeaway() {
  const c = await env.as('CASHIER');
  const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
  const r = await c.post(`/orders/${o.id}/items`, {
    send: true,
    items: [
      { id: randomUUID(), menuItemId: rice.id, qty: 1 },
      { id: randomUUID(), menuItemId: water.id, qty: 2 },
    ],
  });
  expect(r.body.grandTotalSatang).toBe(13910);
  return r.body;
}
const mgr = () => ({ userId: env.userIds.MANAGER, pin: TEST_PIN });

describe('shifts', () => {
  it('requires an open shift to take payment', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    const r = await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 13910 });
    expect(r.body.error.code).toBe('NO_OPEN_SHIFT');
  });
  it('opens one shift per cashier', async () => {
    const c = await env.as('CASHIER');
    expect((await c.post('/shifts/open', { openingFloatSatang: 100000 })).status).toBe(200);
    expect((await c.post('/shifts/open', { openingFloatSatang: 100000 })).status).toBe(409);
    expect((await (await env.as('WAITER')).post('/shifts/open', { openingFloatSatang: 0 })).status).toBe(403);
  });
});

describe('payments', () => {
  it('cash with change; prevents overpayment; settles the bill with a receipt number; idempotent retry', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    expect((await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 20000 })).body.error.code).toBe('OVERPAYMENT');
    expect((await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 13910, tenderedSatang: 10000 })).status).toBe(400);
    const pid = randomUUID();
    const r = await c.post(`/orders/${o.id}/payments`, { id: pid, method: 'CASH', amountSatang: 13910, tenderedSatang: 20000 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PAID');
    expect(r.body.payments[0].changeSatang).toBe(6090);
    expect(r.body.receiptNo).toMatch(/^T1\d{4}-\d{6}$/);
    const again = await c.post(`/orders/${o.id}/payments`, { id: pid, method: 'CASH', amountSatang: 13910, tenderedSatang: 20000 });
    expect(again.status).toBe(200);
    expect(again.body.payments).toHaveLength(1);
    expect(again.body.paidSatang).toBe(13910);
  });

  it('rejects methods the branch has not enabled', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    expect((await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'EWALLET', amountSatang: 100 })).status).toBe(400);
  });

  it('mixed payment: part card (needs reference), part cash', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    expect((await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CARD', amountSatang: 10000 })).status).toBe(400);
    const p1 = await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CARD', amountSatang: 10000, reference: 'APP123' });
    expect(p1.body.status).toBe('OPEN');
    expect(p1.body.paidSatang).toBe(10000);
    const p2 = await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 3910, tenderedSatang: 5000 });
    expect(p2.body.status).toBe('PAID');
  });

  it('PromptPay stays pending until explicitly confirmed with a reference', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    const qr = await c.get(`/orders/${o.id}/promptpay?amount=13910`);
    expect(qr.body.payload).toContain('5406139.10');
    expect(qr.body.dataUrl).toMatch(/^data:image\/png;base64,/);
    const pid = randomUUID();
    const r = await c.post(`/orders/${o.id}/payments`, { id: pid, method: 'PROMPTPAY', amountSatang: 13910 });
    expect(r.body.status).toBe('OPEN');
    expect(r.body.payments[0].status).toBe('PENDING_CONFIRMATION');
    expect((await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 100 })).body.error.code).toBe('NOTHING_DUE');
    expect((await (await env.as('WAITER')).post(`/payments/${pid}/confirm`, { reference: 'x' })).status).toBe(403);
    expect((await c.post(`/payments/${pid}/confirm`, {})).status).toBe(400);
    const ok = await c.post(`/payments/${pid}/confirm`, { reference: 'BANK-REF-1' });
    expect(ok.body.status).toBe('PAID');
  });

  it('refund needs reason + permission/approval and cannot exceed the payment', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    const pid = randomUUID();
    await c.post(`/orders/${o.id}/payments`, { id: pid, method: 'CASH', amountSatang: 13910 });
    expect((await c.post(`/payments/${pid}/refund`, { amountSatang: 1000, reason: 'อาหารเย็น' })).status).toBe(403);
    expect((await c.post(`/payments/${pid}/refund`, { amountSatang: 99999, reason: 'xxx', approval: mgr() })).body.error.code).toBe('REFUND_EXCEEDS');
    const part = await c.post(`/payments/${pid}/refund`, { amountSatang: 2000, reason: 'อาหารเย็น', approval: mgr() });
    expect(part.status).toBe(200);
    expect(part.body.status).toBe('PAID');
    expect(part.body.paidSatang).toBe(11910);
    const rest = await c.post(`/payments/${pid}/refund`, { amountSatang: 11910, reason: 'ยกเลิกทั้งบิล', approval: mgr() });
    expect(rest.body.status).toBe('OPEN');
  });

  it('discounts within the ceiling need bill.discount; above it need an override approval', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    const w = await env.as('WAITER');
    expect((await w.post(`/orders/${o.id}/discounts`, { scope: 'BILL', type: 'PERCENT', value: 1000, reason: 'ลูกค้าประจำ' })).status).toBe(403);
    const ten = await c.post(`/orders/${o.id}/discounts`, { scope: 'BILL', type: 'PERCENT', value: 1000, reason: 'ลูกค้าประจำ' });
    expect(ten.status).toBe(200);
    expect(ten.body.discountSatang).toBe(1300);
    expect(ten.body.grandTotalSatang).toBe(12519);
    expect((await c.post(`/orders/${o.id}/discounts`, { scope: 'BILL', type: 'PERCENT', value: 5000, reason: 'โปรพิเศษ' })).status).toBe(403);
    const big = await c.post(`/orders/${o.id}/discounts`, { scope: 'BILL', type: 'PERCENT', value: 5000, reason: 'โปรพิเศษ', approval: mgr() });
    expect(big.status).toBe(200);
    const item = big.body.items[0];
    const itemDisc = await c.post(`/orders/${o.id}/discounts`, { scope: 'ITEM', orderItemId: item.id, type: 'AMOUNT', value: 1000, reason: 'จานแตก' });
    expect(itemDisc.body.items[0].discountSatang).toBe(1000);
    const removed = await c.del(`/discounts/${ten.body.discounts[0].id}`);
    expect(removed.body.discounts).toHaveLength(2);
  });

  it('issues one full tax invoice per paid bill', async () => {
    const o = await takeaway();
    const c = await env.as('CASHIER');
    const buyer = { buyerName: 'บริษัท ทดสอบ จำกัด', buyerTaxId: '0105599999999', buyerAddress: '99 ถนนทดสอบ กรุงเทพฯ' };
    expect((await c.post(`/orders/${o.id}/tax-invoice`, buyer)).status).toBe(409);
    await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: 13910 });
    const inv = await c.post(`/orders/${o.id}/tax-invoice`, buyer);
    expect(inv.status).toBe(200);
    expect(inv.body.invoiceNo).toMatch(/^INVT1/);
    expect((await c.post(`/orders/${o.id}/tax-invoice`, buyer)).status).toBe(409);
    const rc = await c.get(`/orders/${o.id}/receipt`);
    expect(rc.body.isTaxInvoice).toBe(true);
    expect(rc.body.taxInvoice.invoiceNo).toBe(inv.body.invoiceNo);
  });

  it('paying a dine-in bill releases the table for cleaning', async () => {
    const w = await env.as('WAITER');
    const t = await tableByName(env, 'A1');
    const o = (await w.post(`/tables/${t.id}/open`, { guestCount: 2 })).body;
    const withItems = (await w.post(`/orders/${o.id}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }], send: true })).body;
    const c = await env.as('CASHIER');
    await c.post(`/orders/${o.id}/payments`, { id: randomUUID(), method: 'CASH', amountSatang: withItems.grandTotalSatang });
    const after = await tableByName(env, 'A1');
    expect(after.status).toBe('CLEANING');
    expect(after.currentOrderId).toBeNull();
  });
});

describe('cash drawer and shift close', () => {
  it('pay-in/out need permission or approval; Z report reconciles expected cash and variance', async () => {
    const c = await env.as('CASHIER');
    const cur = (await c.get('/shifts/current')).body;
    const sid = cur.shift.id;
    expect((await c.post(`/shifts/${sid}/cash`, { type: 'PAY_OUT', amountSatang: 5000, reason: 'ซื้อน้ำแข็ง' })).status).toBe(200);
    expect((await c.post(`/shifts/${sid}/cash`, { type: 'NO_SALE', amountSatang: 0, reason: 'แลกเหรียญ' })).status).toBe(403);
    const x = (await c.get(`/shifts/${sid}/report`)).body;
    expect(x.kind).toBe('X');
    const r = x.report;
    const cashIn = r.byMethod.find((m: any) => m.method === 'CASH').amountSatang;
    expect(r.expectedCashSatang).toBe(100000 + cashIn - 5000 - r.refunds.cashSatang);
    const z = await c.post(`/shifts/${sid}/close`, { countedCashSatang: r.expectedCashSatang - 100 });
    expect(z.status).toBe(200);
    expect(z.body.report.varianceSatang).toBe(-100);
    expect((await c.get(`/shifts/${sid}/report`)).body.kind).toBe('Z');
    expect((await c.post(`/shifts/${sid}/close`, { countedCashSatang: 0 })).status).toBe(409);
  });
});
