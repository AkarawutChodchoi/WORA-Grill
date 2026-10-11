import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let zoneId: string;
const t: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv();
  const m = await env.as('MANAGER');
  zoneId = (await m.post('/zones', { name: 'ในร้าน' })).body.id;
  for (const n of ['A1', 'A2', 'A3', 'A4']) t[n] = (await m.post('/tables', { zoneId, name: n, capacity: 4 })).body.id;
});
afterAll(async () => env.close());

const table = async (id: string) => ((await (await env.as('WAITER')).get('/tables')).body.tables as any[]).find((x) => x.id === id);

describe('table management', () => {
  it('only managers can create tables; waiters can view', async () => {
    const w = await env.as('WAITER');
    expect((await w.post('/tables', { zoneId, name: 'X9' })).status).toBe(403);
    expect((await w.get('/tables')).status).toBe(200);
    expect((await (await env.as('KITCHEN')).get('/tables')).status).toBe(403);
  });

  it('rejects duplicate table names in a branch', async () => {
    expect((await (await env.as('MANAGER')).post('/tables', { zoneId, name: 'A1' })).status).toBe(409);
  });

  it('opens a table with guest count, creating a numbered dine-in order', async () => {
    const w = await env.as('WAITER');
    const r = await w.post(`/tables/${t.A1}/open`, { guestCount: 3 });
    expect(r.status).toBe(200);
    expect(r.body.orderNo).toBe('0001');
    expect(r.body.channel).toBe('DINE_IN');
    expect(r.body.pricing.serviceChargeBps).toBe(1000);
    const row = await table(t.A1);
    expect(row.status).toBe('OCCUPIED');
    expect(row.order.guestCount).toBe(3);
  });

  it('prevents two orders claiming the same table', async () => {
    const w = await env.as('WAITER');
    const r = await w.post(`/tables/${t.A1}/open`, { guestCount: 2 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TABLE_OCCUPIED');
  });

  it('handles concurrent opens: exactly one wins', async () => {
    const w = await env.as('WAITER');
    const c = await env.as('CASHIER');
    const [r1, r2] = await Promise.all([w.post(`/tables/${t.A2}/open`, { guestCount: 2 }), c.post(`/tables/${t.A2}/open`, { guestCount: 2 })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });

  it('is idempotent when the client retries with the same order id', async () => {
    const w = await env.as('WAITER');
    const orderId = randomUUID();
    const r1 = await w.post(`/tables/${t.A3}/open`, { guestCount: 2, orderId });
    const r2 = await w.post(`/tables/${t.A3}/open`, { guestCount: 2, orderId });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(orderId);
    expect(r2.body.orderNo).toBe(r1.body.orderNo);
  });

  it('moves a bill to a free table and leaves the old one for cleaning', async () => {
    const w = await env.as('WAITER');
    const before = await table(t.A3);
    expect((await w.post(`/tables/${t.A3}/move`, { toTableId: t.A2 })).status).toBe(409); // A2 occupied
    const r = await w.post(`/tables/${t.A3}/move`, { toTableId: t.A4 });
    expect(r.status).toBe(200);
    const a4 = await table(t.A4);
    expect(a4.currentOrderId).toBe(before.currentOrderId);
    expect((await table(t.A3)).status).toBe('CLEANING');
  });

  it('cleaning tables cannot be opened until marked available; stale version rejected', async () => {
    const w = await env.as('WAITER');
    expect((await w.post(`/tables/${t.A3}/open`, { guestCount: 1 })).body.error.code).toBe('TABLE_CLEANING');
    const row = await table(t.A3);
    expect((await w.post(`/tables/${t.A3}/status`, { status: 'AVAILABLE', version: row.version - 1 })).status).toBe(409);
    expect((await w.post(`/tables/${t.A3}/status`, { status: 'AVAILABLE', version: row.version })).status).toBe(200);
    expect((await w.post(`/tables/${t.A1}/status`, { status: 'AVAILABLE' })).status).toBe(409); // occupied
  });

  it('joins free tables to an occupied one and releases them', async () => {
    const w = await env.as('WAITER');
    expect((await w.post(`/tables/${t.A1}/join`, { tableIds: [t.A2] })).status).toBe(409); // A2 occupied
    expect((await w.post(`/tables/${t.A1}/join`, { tableIds: [t.A3] })).status).toBe(200);
    expect((await table(t.A3)).mergedIntoTableId).toBe(t.A1);
    expect((await w.post(`/tables/${t.A3}/open`, { guestCount: 1 })).status).toBe(409);
    expect((await w.post(`/tables/${t.A1}/unjoin`, { tableIds: [t.A3] })).body.released).toBe(1);
    expect((await table(t.A3)).status).toBe('AVAILABLE');
  });

  it('isolates branches: a table id from another org/branch is not found', async () => {
    const w = await env.as('WAITER');
    expect((await w.post(`/tables/${randomUUID()}/open`, { guestCount: 1 })).status).toBe(404);
  });
});
