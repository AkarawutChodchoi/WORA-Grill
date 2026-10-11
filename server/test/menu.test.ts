import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBranchMenu, resolveLine } from '../src/modules/menu/service';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let catId: string;
let groupId: string;
let itemId: string;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

describe('menu management', () => {
  it('denies menu changes to waiters and allows managers', async () => {
    const w = await env.as('WAITER');
    expect((await w.post('/menu/categories', { name: 'ต้องห้าม' })).status).toBe(403);
    const m = await env.as('MANAGER');
    const c = await m.post('/menu/categories', { name: 'อาหารจานเดียว', nameEn: 'Single dishes', stationCode: 'hot' });
    expect(c.status).toBe(200);
    expect(c.body.stationCode).toBe('HOT');
    catId = c.body.id;
  });

  it('validates modifier group rules on the server', async () => {
    const m = await env.as('MANAGER');
    const bad = await m.post('/menu/modifier-groups', { name: 'x', minSelect: 2, maxSelect: 1, modifiers: [{ name: 'a', priceDeltaSatang: 0 }] });
    expect(bad.status).toBe(400);
    const g = await m.post('/menu/modifier-groups', {
      name: 'ระดับความเผ็ด',
      minSelect: 1,
      maxSelect: 1,
      modifiers: [
        { name: 'ไม่เผ็ด', priceDeltaSatang: 0 },
        { name: 'เผ็ดมาก', priceDeltaSatang: 0 },
        { name: 'พิเศษ (ไข่ดาว)', priceDeltaSatang: 1000 },
      ],
    });
    expect(g.status).toBe(200);
    groupId = g.body.id;
  });

  it('creates an item with branch/channel price and rejects bad input', async () => {
    const m = await env.as('MANAGER');
    expect((await m.post('/menu/items', { categoryId: catId, name: 'ข้าวผัด', priceSatang: -5 })).status).toBe(400);
    expect((await m.post('/menu/items', { categoryId: catId, name: 'ข้าวผัด', priceSatang: 50.5 })).status).toBe(400);
    const r = await m.post('/menu/items', {
      categoryId: catId,
      name: 'ข้าวผัดกุ้ง',
      nameEn: 'Shrimp fried rice',
      priceSatang: 8000,
      allergens: ['shellfish'],
      modifierGroupIds: [groupId],
      prices: [{ branchId: null, channel: 'GRAB', priceSatang: 9500 }],
    });
    expect(r.status).toBe(200);
    itemId = r.body.id;
    const dup = await m.post('/menu/items', { categoryId: catId, name: 'x', priceSatang: 100, prices: [{ branchId: null, channel: 'GRAB', priceSatang: 1 }, { branchId: null, channel: 'GRAB', priceSatang: 2 }] });
    expect(dup.status).toBe(400);
  });

  it('resolves channel prices and station routing in the branch menu', async () => {
    const dine = await loadBranchMenu(env.db, { orgId: env.orgId, branchId: env.branchId, channel: 'DINE_IN' });
    const grab = await loadBranchMenu(env.db, { orgId: env.orgId, branchId: env.branchId, channel: 'GRAB' });
    expect(dine.items.find((i) => i.id === itemId)!.priceSatang).toBe(8000);
    expect(grab.items.find((i) => i.id === itemId)!.priceSatang).toBe(9500);
    expect(dine.items[0].stationCode).toBe('HOT');
  });

  it('validates a line server-side: modifiers required, price from the server', async () => {
    const menu = await loadBranchMenu(env.db, { orgId: env.orgId, branchId: env.branchId, channel: 'DINE_IN' });
    expect(() => resolveLine(menu, { menuItemId: itemId, qty: 1 })).toThrow(/ระดับความเผ็ด/);
    const mod = menu.items[0].modifierGroups[0].modifiers.find((x) => x.priceDeltaSatang === 1000)!;
    const line = resolveLine(menu, { menuItemId: itemId, qty: 1, modifiers: [{ modifierId: mod.id }] });
    expect(line.unitPriceSatang).toBe(9000);
    expect(line.allergens).toEqual(['shellfish']);
  });

  it('kitchen can mark sold out; it propagates to the sellable menu and emits an event', async () => {
    const events: string[] = [];
    const off = env.bus.subscribe((e) => events.push(e.type));
    const k = await env.as('KITCHEN');
    expect((await k.post(`/menu/items/${itemId}/sold-out`, { soldOut: true })).status).toBe(200);
    off();
    expect(events).toContain('menu.sold_out');
    const menu = await loadBranchMenu(env.db, { orgId: env.orgId, branchId: env.branchId, channel: 'DINE_IN' });
    const it2 = menu.items.find((i) => i.id === itemId)!;
    expect(it2.available).toBe(false);
    expect(it2.unavailableReason).toBe('SOLD_OUT');
    expect(() => resolveLine(menu, { menuItemId: itemId, qty: 1 })).toThrow(/หมด/);
    // waiter cannot 86
    expect((await (await env.as('WAITER')).post(`/menu/items/${itemId}/sold-out`, { soldOut: false })).status).toBe(403);
    await k.post(`/menu/items/${itemId}/sold-out`, { soldOut: false });
  });

  it('archived categories hide their items; edits to modifiers archive rather than delete', async () => {
    const m = await env.as('MANAGER');
    const admin = await m.get('/menu/admin');
    const g = admin.body.modifierGroups.find((x: any) => x.id === groupId);
    const keep = g.modifiers.slice(0, 2).map((x: any) => ({ id: x.id, name: x.name, priceDeltaSatang: x.priceDeltaSatang }));
    expect((await m.put(`/menu/modifier-groups/${groupId}`, { name: g.name, minSelect: 1, maxSelect: 1, modifiers: keep })).status).toBe(200);
    const after = (await m.get('/menu/admin')).body.modifierGroups.find((x: any) => x.id === groupId);
    expect(after.modifiers).toHaveLength(3);
    expect(after.modifiers.filter((x: any) => x.archivedAt)).toHaveLength(1);

    expect((await m.patch(`/menu/categories/${catId}`, { archived: true })).status).toBe(200);
    const menu = await loadBranchMenu(env.db, { orgId: env.orgId, branchId: env.branchId, channel: 'DINE_IN' });
    expect(menu.items).toHaveLength(0);
    await m.patch(`/menu/categories/${catId}`, { archived: false });
  });

  it('rejects non-image uploads by content', async () => {
    const m = await env.as('MANAGER');
    const boundary = '----x';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n<script>alert(1)</script>\r\n--${boundary}--\r\n`;
    const r = await env.app.inject({
      method: 'POST',
      url: `/api/menu/items/${itemId}/image`,
      payload,
      headers: { cookie: m.cookie, 'x-requested-with': 'rms', 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(r.statusCode).toBe(400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const ok = await env.app.inject({
      method: 'POST',
      url: `/api/menu/items/${itemId}/image`,
      payload: body,
      headers: { cookie: m.cookie, 'x-requested-with': 'rms', 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().imageUrl).toMatch(/^\/uploads\/menu\/[\w-]+\.png$/);
  });
});
