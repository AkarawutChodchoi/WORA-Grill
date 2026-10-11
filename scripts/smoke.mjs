// End-to-end smoke test against a running server (default http://localhost:3000).
// Usage: SMOKE_EMAIL=owner@demo.local SMOKE_PASSWORD=... node scripts/smoke.mjs [baseUrl]
// Walks a full dine-in flow on the DEMO data: login → open table → order → kitchen → pay → receipt → report.
const base = process.argv[2] ?? 'http://localhost:3000';
const email = process.env.SMOKE_EMAIL ?? 'owner@demo.local';
const password = process.env.SMOKE_PASSWORD;
if (!password) {
  console.error('Set SMOKE_PASSWORD (the owner password printed by `npm run db:seed`).');
  process.exit(2);
}
let cookie = '';
async function call(method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'rms', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}
const step = async (name, fn) => {
  const r = await fn();
  console.log(`✔ ${name}`);
  return r;
};

const health = await step('health', () => call('GET', '/health'));
if (health.db !== 'up') throw new Error('database down');
await step('login', () => call('POST', '/auth/login', { email, password }));
const me = await step('session', () => call('GET', '/auth/me'));
const floor = await step('floor plan', () => call('GET', '/tables'));
const table = floor.tables.find((t) => t.status === 'AVAILABLE');
const order = await step(`open table ${table.name}`, () => call('POST', `/tables/${table.id}/open`, { guestCount: 2, orderId: crypto.randomUUID() }));
const menu = await step('menu', () => call('GET', '/menu?channel=DINE_IN'));
const simple = menu.items.find((i) => i.available && i.modifierGroups.every((g) => g.minSelect === 0));
const withItems = await step(`order ${simple.name} ×2 and send`, () => call('POST', `/orders/${order.id}/items`, { send: true, items: [{ id: crypto.randomUUID(), menuItemId: simple.id, qty: 2 }] }));
const kds = await step('kitchen display', () => call('GET', '/kds?station=ALL'));
const lines = kds.tickets.find((t) => t.orderId === order.id).items;
await step('kitchen: ready', () => call('POST', '/kds/status', { itemIds: lines.map((l) => l.id), status: 'READY' }));
await step('floor: served', () => call('POST', '/kds/status', { itemIds: lines.map((l) => l.id), status: 'SERVED' }));
await step('request bill', () => call('POST', `/orders/${order.id}/request-bill`));
const shift = await call('GET', '/shifts/current');
if (!shift.shift) await step('open shift', () => call('POST', '/shifts/open', { openingFloatSatang: 100000 }));
const paid = await step(`pay cash ${(withItems.grandTotalSatang / 100).toFixed(2)}`, () =>
  call('POST', `/orders/${order.id}/payments`, { id: crypto.randomUUID(), method: 'CASH', amountSatang: withItems.grandTotalSatang, tenderedSatang: Math.ceil(withItems.grandTotalSatang / 10000) * 10000 }),
);
if (paid.status !== 'PAID') throw new Error('order not paid');
const receipt = await step(`receipt ${paid.receiptNo}`, () => call('GET', `/orders/${order.id}/receipt`));
const today = paid.businessDate;
const report = await step('sales report', () => call('GET', `/reports/sales?from=${today}&to=${today}`));
if (report.totals.totalSatang < withItems.grandTotalSatang) throw new Error('report does not include the sale');
console.log(`\nSmoke test passed for ${me.organization.name} / ${me.branch.name}: bill #${paid.orderNo}, receipt ${receipt.order.receiptNo}, today's sales ${(report.totals.totalSatang / 100).toFixed(2)} THB`);
