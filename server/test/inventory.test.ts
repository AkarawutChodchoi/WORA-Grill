import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stockBalances, stockMovements } from '../src/db/schema';
import { createTestEnv, itemBySku, TEST_PIN, type TestEnv } from './helpers';

let env: TestEnv;
let rice: string; // ingredient: rice (g)
let shrimp: string; // ingredient: shrimp (g), tracks expiry
let egg: string; // ingredient: egg (pcs), bought by the tray of 30
let friedRice: any; // menu item M001 with extras group
let extraEggMod: string;

const onHand = async (ingredientId: string) => {
  const [b] = await env.db.select().from(stockBalances).where(eq(stockBalances.ingredientId, ingredientId));
  return b ? Number(b.qty) : 0;
};

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  const m = await env.as('MANAGER');
  rice = (await m.post('/inventory/ingredients', { name: 'ข้าวสาร', baseUnit: 'g', reorderPoint: '1000', units: [{ unit: 'kg', factor: '1000', isPurchase: true }] })).body.id;
  shrimp = (await m.post('/inventory/ingredients', { name: 'กุ้ง', baseUnit: 'g', trackExpiry: true, units: [{ unit: 'kg', factor: '1000', isPurchase: true }] })).body.id;
  egg = (await m.post('/inventory/ingredients', { name: 'ไข่ไก่', baseUnit: 'pcs', units: [{ unit: 'แผง', factor: '30', isPurchase: true }] })).body.id;
  friedRice = await itemBySku(env, 'M001');
  const menu = (await m.get('/menu')).body;
  extraEggMod = menu.items.find((i: any) => i.id === friedRice.id).modifierGroups[0].modifiers.find((x: any) => x.name === 'ไข่ดาว').id;
});
afterAll(async () => env.close());

describe('units and recipes', () => {
  it('converts purchase units to base units on receive and costs per base unit', async () => {
    const s = await env.as('STOREKEEPER');
    // 5 kg rice @ 40 THB/kg; 1 tray of eggs @ 120 THB/tray; 2 kg shrimp in two lots with different expiry
    const r = await s.post('/inventory/receive', {
      lines: [
        { ingredientId: rice, qty: '5', unit: 'kg', unitCostSatang: 4000 },
        { ingredientId: egg, qty: '1', unit: 'แผง', unitCostSatang: 12000 },
        { ingredientId: shrimp, qty: '1', unit: 'kg', unitCostSatang: 30000, lotNo: 'L-LATE', expiryDate: '2099-12-31' },
        { ingredientId: shrimp, qty: '1', unit: 'kg', unitCostSatang: 30000, lotNo: 'L-SOON', expiryDate: '2099-01-01' },
      ],
    });
    expect(r.status).toBe(200);
    expect(await onHand(rice)).toBe(5000);
    expect(await onHand(egg)).toBe(30);
    const m = await env.as('MANAGER');
    const list = (await m.get('/inventory/ingredients')).body.ingredients;
    expect(list.find((i: any) => i.id === rice).avgCost).toBe('4.000000'); // satang per gram
    expect(list.find((i: any) => i.id === egg).avgCost).toBe('400.000000'); // 4 THB per egg
  });

  it('rejects unknown units', async () => {
    const s = await env.as('STOREKEEPER');
    expect((await s.post('/inventory/receive', { lines: [{ ingredientId: rice, qty: '1', unit: 'ลัง', unitCostSatang: 1 }] })).status).toBe(400);
  });

  it('saves recipes for a menu item and a modifier, and computes plate cost', async () => {
    const m = await env.as('MANAGER');
    expect((await m.put('/inventory/recipes', { menuItemId: friedRice.id, lines: [{ ingredientId: rice, qty: '0.2', unit: 'kg' }, { ingredientId: shrimp, qty: '80', unit: 'g' }, { ingredientId: egg, qty: '1', unit: 'pcs' }] })).status).toBe(200);
    expect((await m.put('/inventory/recipes', { modifierId: extraEggMod, lines: [{ ingredientId: egg, qty: '1', unit: 'pcs' }] })).status).toBe(200);
    const costs = (await m.get('/inventory/menu-costs')).body.items;
    const fr = costs.find((c: any) => c.menuItemId === friedRice.id);
    // 200 g × 4 + 80 g × 30 + 1 × 400 = 800 + 2400 + 400 = 3600 satang on a 90 THB dish = 40%
    expect(fr.costSatang).toBe(3600);
    expect(fr.foodCostPct).toBe(40);
    expect((await (await env.as('STOREKEEPER')).get('/inventory/menu-costs')).status).toBe(403);
  });
});

describe('sales deduction', () => {
  let orderId: string;
  const line = randomUUID();

  it('deducts recipe + modifier ingredients when items are sent, once', async () => {
    const c = await env.as('CASHIER');
    orderId = (await c.post('/orders', { channel: 'TAKEAWAY' })).body.id;
    const add = { items: [{ id: line, menuItemId: friedRice.id, qty: 2, modifiers: [{ modifierId: extraEggMod }] }] };
    await c.post(`/orders/${orderId}/items`, add);
    expect(await onHand(rice)).toBe(5000); // drafts do not deduct
    await c.post(`/orders/${orderId}/send`, {});
    expect(await onHand(rice)).toBe(4600);
    expect(await onHand(egg)).toBe(26); // (1 recipe + 1 extra egg) × 2
    expect(await onHand(shrimp)).toBe(1840);
    // retries / re-sends do not deduct twice
    await c.post(`/orders/${orderId}/items`, { ...add, send: true });
    await c.post(`/orders/${orderId}/send`, {});
    expect(await onHand(rice)).toBe(4600);
    const sales = await env.db.select().from(stockMovements).where(and(eq(stockMovements.refId, line), eq(stockMovements.type, 'SALE')));
    expect(sales).toHaveLength(3);
  });

  it('consumes shrimp lots first-expiry-first-out', async () => {
    const lots = (await (await env.as('MANAGER')).get('/inventory/expiring?days=36500')).body.lots;
    const soon = lots.find((l: any) => l.lotNo === 'L-SOON');
    const late = lots.find((l: any) => l.lotNo === 'L-LATE');
    expect(Number(soon.remainingQty)).toBe(840);
    expect(Number(late.remainingQty)).toBe(1000);
  });

  it('reverses the deduction when a sent item is cancelled', async () => {
    const c = await env.as('CASHIER');
    const r = await c.post(`/order-items/${line}/cancel`, { reason: 'ลูกค้ายกเลิก', approval: { userId: env.userIds.MANAGER, pin: TEST_PIN } });
    expect(r.status).toBe(200);
    expect(await onHand(rice)).toBe(5000);
    expect(await onHand(egg)).toBe(30);
  });

  it('flags low stock when crossing the reorder point', async () => {
    const events: any[] = [];
    const off = env.bus.subscribe((e) => e.type === 'stock.low' && events.push(e));
    const s = await env.as('STOREKEEPER');
    await s.post('/inventory/issue', { reason: 'ใช้ทำอาหารพนักงาน', lines: [{ ingredientId: rice, qty: '4.2', unit: 'kg' }] });
    off();
    expect(events).toHaveLength(1);
    expect((await s.get('/inventory/low-stock')).body.items.map((i: any) => i.id)).toContain(rice);
  });
});

describe('waste, adjustments, counts and costing', () => {
  it('records waste with a reason and blocks manual issues below zero', async () => {
    const s = await env.as('STOREKEEPER');
    expect((await s.post('/inventory/waste', { reason: 'ไข่แตก', lines: [{ ingredientId: egg, qty: '2', unit: 'pcs' }] })).status).toBe(200);
    expect(await onHand(egg)).toBe(28);
    const over = await s.post('/inventory/issue', { reason: 'ทดสอบ', lines: [{ ingredientId: egg, qty: '100', unit: 'pcs' }] });
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await onHand(egg)).toBe(28);
  });

  it('adjustment needs stock.adjust or approval', async () => {
    const s = await env.as('STOREKEEPER');
    expect((await s.post('/inventory/adjust', { reason: 'แก้ยอด', lines: [{ ingredientId: egg, newQty: '25' }] })).status).toBe(403);
    expect((await s.post('/inventory/adjust', { reason: 'แก้ยอด', approval: { userId: env.userIds.MANAGER, pin: TEST_PIN }, lines: [{ ingredientId: egg, newQty: '25' }] })).status).toBe(200);
    expect(await onHand(egg)).toBe(25);
  });

  it('weighted average cost updates on a receipt at a new price', async () => {
    const s = await env.as('STOREKEEPER');
    // 25 eggs @ 4.00 + 30 eggs @ 5.00 (150/tray) → avg = (100 + 150) / 55 = 4.5454…
    await s.post('/inventory/receive', { lines: [{ ingredientId: egg, qty: '1', unit: 'แผง', unitCostSatang: 15000 }] });
    const list = (await (await env.as('MANAGER')).get('/inventory/ingredients')).body.ingredients;
    expect(Number(list.find((i: any) => i.id === egg).avgCost)).toBeCloseTo(454.545454, 4);
    // storekeepers see quantities but not costs
    const sk = (await s.get('/inventory/ingredients')).body.ingredients;
    expect(sk.find((i: any) => i.id === egg).avgCost).toBeNull();
  });

  it('stock count shows theoretical vs counted variance and posts COUNT movements', async () => {
    const s = await env.as('STOREKEEPER');
    const count = (await s.post('/inventory/counts', { ingredientIds: [egg, rice] })).body;
    await s.put(`/inventory/counts/${count.id}`, { lines: [{ ingredientId: egg, countedQty: '50' }] });
    const sheet = (await s.get(`/inventory/counts/${count.id}`)).body;
    expect(sheet.lines.find((l: any) => l.ingredientId === egg)).toMatchObject({ theoreticalQty: '55.0000', countedQty: '50.0000', varianceQty: '-5.0000' });
    expect((await s.post(`/inventory/counts/${count.id}/post`, {})).status).toBe(403);
    expect((await s.post(`/inventory/counts/${count.id}/post`, { approval: { userId: env.userIds.MANAGER, pin: TEST_PIN } })).status).toBe(200);
    expect(await onHand(egg)).toBe(50);
    expect(await onHand(rice)).toBe(800); // not counted → untouched
    expect((await s.post(`/inventory/counts/${count.id}/post`, { approval: { userId: env.userIds.MANAGER, pin: TEST_PIN } })).status).toBe(409);
  });

  it('produces a sub-recipe batch at the cost of its ingredients', async () => {
    const m = await env.as('MANAGER');
    const stock = (await m.post('/inventory/ingredients', { name: 'น้ำซุปไข่', baseUnit: 'ml', isSubRecipe: true })).body.id;
    await m.put('/inventory/recipes', { outputIngredientId: stock, yieldQty: '1000', lines: [{ ingredientId: egg, qty: '10', unit: 'pcs' }] });
    expect((await m.post('/inventory/produce', { outputIngredientId: stock, batches: '2' })).status).toBe(200);
    expect(await onHand(stock)).toBe(2000);
    expect(await onHand(egg)).toBe(30);
  });

  it('ledger and cache agree (reconcile reports no drift)', async () => {
    const m = await env.as('MANAGER');
    expect((await m.post('/inventory/reconcile')).body.drift).toEqual([]);
  });
});
