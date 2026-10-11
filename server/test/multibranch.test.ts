import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendance, stockBalances, userRoles, users, warehouses } from '../src/db/schema';
import { hashSecret } from '../src/lib/crypto';
import { businessDate } from '../src/lib/time';
import { Client, createTestEnv, tableByName, TEST_PASSWORD, type TestEnv } from './helpers';

let env: TestEnv;
let branchB: string;
let mgrB: Client;
let flour: string;
const today = businessDate('Asia/Bangkok');

beforeAll(async () => {
  env = await createTestEnv({ demo: true });
  const owner = await env.as('OWNER');
  const b = await owner.post('/org/branches', { name: 'สาขาสอง', code: 'B2', copySettingsFromBranchId: env.branchId });
  expect(b.status).toBe(200);
  branchB = b.body.id;
  // a manager who only belongs to branch B
  const [u] = await env.db.insert(users).values({ organizationId: env.orgId, name: 'mgr-b', email: 'mgrb@test.local', passwordHash: await hashSecret(TEST_PASSWORD) }).returning();
  await env.db.insert(userRoles).values({ userId: u.id, roleId: env.roleIds.MANAGER, branchId: branchB });
  mgrB = new Client(env.app);
  await mgrB.post('/auth/login', { email: 'mgrb@test.local', password: TEST_PASSWORD });
  flour = (await owner.post('/inventory/ingredients', { name: 'แป้ง', baseUnit: 'g', units: [{ unit: 'kg', factor: '1000' }] })).body.id;
});
afterAll(async () => env.close());

describe('branch administration', () => {
  it('only org-wide org.manage can create branches', async () => {
    expect((await (await env.as('MANAGER')).post('/org/branches', { name: 'x', code: 'X1' })).status).toBe(403);
    expect((await mgrB.post('/org/branches', { name: 'x', code: 'X2' })).status).toBe(403);
    expect((await (await env.as('OWNER')).post('/org/branches', { name: 'dup', code: 'B2' })).status).toBe(409);
  });

  it('owner sees every branch; branch manager only their own', async () => {
    expect((await (await env.as('OWNER')).get('/auth/me')).body.branches).toHaveLength(2);
    const me = (await mgrB.get('/auth/me')).body;
    expect(me.branches.map((b: any) => b.id)).toEqual([branchB]);
    expect(me.branch.id).toBe(branchB);
  });
});

describe('branch isolation', () => {
  it('a user cannot switch into or read another branch by changing ids', async () => {
    expect((await mgrB.post('/auth/branch', { branchId: env.branchId })).status).toBe(403);
    const a1 = await tableByName(env, 'A1');
    expect((await mgrB.post(`/tables/${a1.id}/open`, { guestCount: 2 })).status).toBe(404);
    const w = await env.as('WAITER');
    const order = (await w.post(`/tables/${a1.id}/open`, { guestCount: 2 })).body;
    expect((await mgrB.get(`/orders/${order.id}`)).status).toBe(404);
    expect((await mgrB.post(`/orders/${order.id}/void`, { reason: 'ลองข้ามสาขา' })).status).toBe(404);
    expect((await mgrB.get('/tables')).body.tables).toHaveLength(0);
    expect((await mgrB.get(`/reports/sales?from=${today}&to=${today}&branches=${env.branchId}`)).status).toBe(403);
    expect((await mgrB.get('/users')).body.users.map((u: any) => u.name)).toEqual(['mgr-b']);
    expect((await mgrB.patch(`/users/${env.userIds.WAITER}`, { name: 'x' })).status).toBe(403);
  });

  it('central menu is shared, but sold-out / enable flags are per branch', async () => {
    const m = await env.as('MANAGER');
    const items = (await m.get('/menu')).body.items;
    const dish = items[0];
    await (await env.as('KITCHEN')).post(`/menu/items/${dish.id}/sold-out`, { soldOut: true });
    const inB = (await mgrB.get('/menu')).body.items.find((i: any) => i.id === dish.id);
    expect(inB.available).toBe(true);
    expect((await m.get('/menu')).body.items.find((i: any) => i.id === dish.id).available).toBe(false);
  });

  it('owner reports can span all branches', async () => {
    const r = await (await env.as('OWNER')).get(`/reports/sales?from=${today}&to=${today}&branches=all`);
    expect(r.status).toBe(200);
    expect(r.body.range.branchIds).toHaveLength(2);
  });
});

describe('stock transfers between branches', () => {
  it('ships from A, receives at B with a recorded shortage', async () => {
    const s = await env.as('STOREKEEPER');
    await s.post('/inventory/receive', { lines: [{ ingredientId: flour, qty: '10', unit: 'kg', unitCostSatang: 3000 }] });
    const t = await s.post('/transfers', { mode: 'SHIP', otherBranchId: branchB, lines: [{ ingredientId: flour, qty: '4', unit: 'kg' }] });
    expect(t.status).toBe(200);
    expect(t.body.status).toBe('SHIPPED');
    const whA = (await env.db.select().from(warehouses).where(and(eq(warehouses.branchId, env.branchId), eq(warehouses.isDefault, true))))[0];
    const [balA] = await env.db.select().from(stockBalances).where(and(eq(stockBalances.warehouseId, whA.id), eq(stockBalances.ingredientId, flour)));
    expect(Number(balA.qty)).toBe(6000);
    const list = (await mgrB.get('/transfers')).body.transfers;
    const line = list[0].lines[0];
    expect(list[0].direction).toBe('IN');
    expect((await mgrB.post(`/transfers/${t.body.id}/receive`, { lines: [{ lineId: line.id, receivedQtyBase: '3900' }] })).status).toBe(400);
    expect((await mgrB.post(`/transfers/${t.body.id}/receive`, { lines: [{ lineId: line.id, receivedQtyBase: '3900', reason: 'ถุงขาด' }] })).status).toBe(200);
    const whB = (await env.db.select().from(warehouses).where(and(eq(warehouses.branchId, branchB), eq(warehouses.isDefault, true))))[0];
    const [balB] = await env.db.select().from(stockBalances).where(and(eq(stockBalances.warehouseId, whB.id), eq(stockBalances.ingredientId, flour)));
    expect(Number(balB.qty)).toBe(3900);
    expect(Number(balB.avgCost)).toBe(3); // 30 THB/kg = 3 satang/g carried over
    expect((await mgrB.post(`/transfers/${t.body.id}/receive`, {})).status).toBe(409);
    // the sending branch cannot "receive" its own shipment
    expect((await s.post(`/transfers/${t.body.id}/receive`, {})).status).toBe(404);
  });

  it('a branch can request stock; the supplier branch ships it', async () => {
    const req = await mgrB.post('/transfers', { mode: 'REQUEST', otherBranchId: env.branchId, lines: [{ ingredientId: flour, qty: '1', unit: 'kg' }] });
    expect(req.body.status).toBe('REQUESTED');
    expect((await mgrB.post(`/transfers/${req.body.id}/ship`)).status).toBe(404); // only the sender ships
    expect((await (await env.as('STOREKEEPER')).post(`/transfers/${req.body.id}/ship`)).status).toBe(200);
    expect((await mgrB.post(`/transfers/${req.body.id}/receive`)).status).toBe(200);
  });
});

describe('staff scheduling and attendance', () => {
  const at = (h: number) => {
    const d = new Date(Date.now() + 2 * 86_400_000);
    d.setUTCHours(h - 7, 0, 0, 0);
    return d.toISOString();
  };

  it('schedules shifts and prevents double-booking a person', async () => {
    const m = await env.as('MANAGER');
    expect((await m.post('/schedules', { userId: env.userIds.WAITER, startsAt: at(10), endsAt: at(18) })).status).toBe(200);
    expect((await m.post('/schedules', { userId: env.userIds.WAITER, startsAt: at(17), endsAt: at(22) })).body.error.code).toBe('SHIFT_OVERLAP');
    expect((await m.post('/schedules', { userId: env.userIds.WAITER, startsAt: at(18), endsAt: at(10) })).status).toBe(400);
    // manager of branch B cannot schedule a branch-A waiter in B
    expect((await mgrB.post('/schedules', { userId: env.userIds.WAITER, startsAt: at(8), endsAt: at(9) })).status).toBe(400);
    expect((await (await env.as('WAITER')).post('/schedules', { userId: env.userIds.WAITER, startsAt: at(8), endsAt: at(9) })).status).toBe(403);
  });

  it('clock in/out once; manager edits need a reason and are audited; labor cost reaches reports', async () => {
    const w = await env.as('WAITER');
    expect((await w.post('/attendance/clock', { action: 'out' })).body.error.code).toBe('NOT_IN');
    const rec = (await w.post('/attendance/clock', { action: 'in' })).body;
    expect((await w.post('/attendance/clock', { action: 'in' })).body.error.code).toBe('ALREADY_IN');
    await w.post('/attendance/clock', { action: 'out' });
    const m = await env.as('MANAGER');
    const start = new Date(Date.now() - 4 * 3_600_000).toISOString();
    expect((await m.patch(`/attendance/${rec.id}`, { clockInAt: start, clockOutAt: new Date().toISOString() })).status).toBe(400);
    expect((await m.patch(`/attendance/${rec.id}`, { clockInAt: start, clockOutAt: new Date().toISOString(), reason: 'ลืมลงเวลา' })).status).toBe(200);
    const [row] = await env.db.select().from(attendance).where(eq(attendance.id, rec.id));
    expect(row.editedBy).toBe(env.userIds.MANAGER);
    await m.put(`/staff/${env.userIds.WAITER}/profile`, { position: 'พนักงานเสิร์ฟ', wageType: 'HOURLY', wageRateSatang: 5000 });
    const from = businessDate('Asia/Bangkok', new Date(start));
    const costs = (await m.get(`/reports/costs?from=${from}&to=${today}`)).body;
    expect(costs.labor.available).toBe(true);
    expect(costs.labor.costSatang).toBe(20000); // 4 h × 50 THB
  });
});

