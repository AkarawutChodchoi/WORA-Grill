import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stockBalances, stockMovements } from '../src/db/schema';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let oil: string; // ml; bought by the 1-litre bottle and by the 12-bottle case
let supplierA: string;

let poId: string;
let lineId: string;

const onHand = async (id: string) => Number((await env.db.select().from(stockBalances).where(eq(stockBalances.ingredientId, id)))[0]?.qty ?? 0);

beforeAll(async () => {
  env = await createTestEnv();
  const m = await env.as('MANAGER');
  oil = (
    await m.post('/inventory/ingredients', {
      name: 'น้ำมันพืช',
      baseUnit: 'ml',
      reorderPoint: '5000',
      reorderQty: '12000',
      units: [
        { unit: 'ขวด', factor: '1000', isPurchase: true },
        { unit: 'ลัง', factor: '12000', isPurchase: true },
      ],
    })
  ).body.id;
  supplierA = (await m.post('/purchasing/suppliers', { name: 'แม็คโคร', paymentTermsDays: 0, items: [{ ingredientId: oil, unit: 'ลัง', priceSatang: 60000 }] })).body.id;
  await (m.post('/purchasing/suppliers', { name: 'ร้านส่งตลาด', paymentTermsDays: 30, items: [{ ingredientId: oil, unit: 'ขวด', priceSatang: 4800, isPreferred: true, leadTimeDays: 2 }] }));
});
afterAll(async () => env.close());

describe('suppliers', () => {
  it('only managers can maintain suppliers; units are validated', async () => {
    expect((await (await env.as('STOREKEEPER')).post('/purchasing/suppliers', { name: 'x' })).status).toBe(403);
    expect((await (await env.as('MANAGER')).post('/purchasing/suppliers', { name: 'bad', items: [{ ingredientId: oil, unit: 'ถัง', priceSatang: 1 }] })).status).toBe(400);
  });
  it('compares prices per base unit', async () => {
    const r = (await (await env.as('MANAGER')).get(`/purchasing/price-compare?ingredientId=${oil}`)).body.prices;
    expect(r[0].supplier).toBe('ร้านส่งตลาด'); // 48/1000 ml vs 600/12000 ml
    expect(r[0].pricePerBaseSatang).toBe(4.8);
    expect(r[1].pricePerBaseSatang).toBe(5);
  });
});

describe('purchase request → order → receipt', () => {
  it('suggests replenishment for items below reorder point', async () => {
    const r = (await (await env.as('MANAGER')).get('/purchasing/suggestions')).body.items;
    const s = r.find((i: any) => i.ingredientId === oil);
    expect(s.basis).toBe('REORDER_POINT');
    expect(s.suggestion).toMatchObject({ supplier: 'ร้านส่งตลาด', unit: 'ขวด', qty: 12 });
  });

  it('creates, submits and approves a PO; receiving before approval is refused', async () => {
    const m = await env.as('MANAGER');
    const po = (await m.post('/purchasing/orders', { supplierId: supplierA, lines: [{ ingredientId: oil, qty: '2', unit: 'ลัง', unitPriceSatang: 60000 }] })).body;
    poId = po.id;
    expect(po.poNo).toMatch(/^POT1\d{4}-00001$/);
    const detail = (await m.get(`/purchasing/orders/${poId}`)).body;
    lineId = detail.lines[0].id;
    expect(detail.totalSatang).toBe(120000);
    const s = await env.as('STOREKEEPER');
    const early = await s.post('/purchasing/receipts', { id: randomUUID(), poId, supplierId: supplierA, lines: [{ poLineId: lineId, ingredientId: oil, unit: 'ลัง', deliveredQty: '1', unitPriceSatang: 60000 }] });
    expect(early.body.error.code).toBe('PO_NOT_RECEIVABLE');
    expect(await onHand(oil)).toBe(0); // creating a PO never adds stock
    expect((await s.post(`/purchasing/orders/${poId}/approve`)).status).toBe(403);
    expect((await m.post(`/purchasing/orders/${poId}/submit`)).body.status).toBe('SUBMITTED');
    expect((await m.post(`/purchasing/orders/${poId}/approve`)).body.status).toBe('APPROVED');
    expect((await m.post(`/purchasing/orders/${poId}/approve`)).status).toBe(409);
  });

  it('partial receipt with damaged goods; duplicate posting is ignored', async () => {
    const s = await env.as('STOREKEEPER');
    const grId = randomUUID();
    const body = {
      id: grId,
      poId,
      supplierId: supplierA,
      invoiceNo: 'INV-001',
      lines: [{ poLineId: lineId, ingredientId: oil, unit: 'ลัง', deliveredQty: '1.5', rejectedQty: '0.5', rejectReason: 'ขวดแตก', unitPriceSatang: 60000 }],
    };
    expect((await s.post('/purchasing/receipts', { ...body, id: randomUUID(), lines: [{ ...body.lines[0], rejectReason: undefined }] })).status).toBe(400);
    const gr = await s.post('/purchasing/receipts', body);
    expect(gr.status).toBe(200);
    expect(gr.body.totalSatang).toBe(60000); // only accepted goods are billed
    expect(await onHand(oil)).toBe(12000);
    const replay = await s.post('/purchasing/receipts', body);
    expect(replay.body.replay).toBe(true);
    expect(await onHand(oil)).toBe(12000);
    const po = (await s.get(`/purchasing/orders/${poId}`)).body;
    expect(po.status).toBe('PARTIAL');
    expect(Number(po.lines[0].receivedQtyBase)).toBe(12000);
  });

  it('refuses over-receipt, then completes the PO', async () => {
    const s = await env.as('STOREKEEPER');
    const over = await s.post('/purchasing/receipts', { id: randomUUID(), poId, supplierId: supplierA, lines: [{ poLineId: lineId, ingredientId: oil, unit: 'ลัง', deliveredQty: '2', unitPriceSatang: 60000 }] });
    expect(over.body.error.code).toBe('OVER_RECEIPT');
    const ok = await s.post('/purchasing/receipts', { id: randomUUID(), poId, supplierId: supplierA, lines: [{ poLineId: lineId, ingredientId: oil, unit: 'ขวด', deliveredQty: '12', unitPriceSatang: 5000 }] });
    expect(ok.status).toBe(200);
    expect((await s.get(`/purchasing/orders/${poId}`)).body.status).toBe('RECEIVED');
    expect(await onHand(oil)).toBe(24000);
    // weighted average: (12000×50 + 12000×50)/24000 = 50 satang... i.e. 0.05 THB per ml
    const [bal] = await env.db.select().from(stockBalances).where(eq(stockBalances.ingredientId, oil));
    expect(Number(bal.avgCost)).toBeCloseTo(5, 6);
  });

  it('every stock change is traceable to its receipt and user', async () => {
    const mv = await env.db.select().from(stockMovements).where(eq(stockMovements.ingredientId, oil));
    expect(mv.every((m) => m.refType === 'goods_receipt' && m.createdBy === env.userIds.STOREKEEPER)).toBe(true);
    expect(mv.reduce((n, m) => n + Number(m.qty), 0)).toBe(await onHand(oil));
  });

  it('supplier return removes stock and credits the payable; cannot exceed what was received', async () => {
    const s = await env.as('STOREKEEPER');
    const grs = (await s.get('/purchasing/receipts')).body.receipts;
    const firstGr = grs.find((g: any) => g.totalSatang === 60000);
    expect((await s.post('/purchasing/returns', { id: randomUUID(), supplierId: supplierA, grId: firstGr.id, reason: 'คืนของไม่ได้มาตรฐาน', lines: [{ ingredientId: oil, qty: '2', unit: 'ลัง' }] })).body.error.code).toBe('OVER_RETURN');
    const rt = await s.post('/purchasing/returns', { id: randomUUID(), supplierId: supplierA, grId: firstGr.id, reason: 'คืนของไม่ได้มาตรฐาน', lines: [{ ingredientId: oil, qty: '2', unit: 'ขวด' }] });
    expect(rt.status).toBe(200);
    expect(rt.body.creditSatang).toBe(10000);
    expect(await onHand(oil)).toBe(22000);
  });

  it('tracks payables and blocks overpaying an invoice', async () => {
    const m = await env.as('MANAGER');
    const ap = (await m.get('/purchasing/payables')).body;
    const sa = ap.suppliers.find((x: any) => x.supplierId === supplierA);
    expect(sa).toMatchObject({ billedSatang: 120000, creditSatang: 10000, paidSatang: 0, outstandingSatang: 110000 });
    const gr = ap.receipts[0];
    expect((await m.post('/purchasing/payments', { id: randomUUID(), supplierId: supplierA, grId: gr.id, amountSatang: gr.totalSatang + 1, method: 'TRANSFER', paidAt: '2026-10-12' })).body.error.code).toBe('OVERPAYMENT');
    expect((await m.post('/purchasing/payments', { id: randomUUID(), supplierId: supplierA, grId: gr.id, amountSatang: gr.totalSatang, method: 'TRANSFER', paidAt: '2026-10-12' })).status).toBe(200);
    expect((await (await env.as('STOREKEEPER')).post('/purchasing/payments', { id: randomUUID(), supplierId: supplierA, amountSatang: 1, method: 'CASH', paidAt: '2026-10-12' })).status).toBe(403);
  });
});
