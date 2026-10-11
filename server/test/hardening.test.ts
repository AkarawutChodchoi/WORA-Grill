import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, itemBySku, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ demo: true });
});
afterAll(async () => env.close());

describe('HTTP hardening', () => {
  it('accepts action POSTs with a JSON content-type and an empty body', async () => {
    const c = await env.as('CASHIER');
    const o = (await c.post('/orders', { channel: 'TAKEAWAY' })).body;
    const water = await itemBySku(env, 'D004');
    await c.post(`/orders/${o.id}/items`, { items: [{ id: randomUUID(), menuItemId: water.id, qty: 1 }] });
    const r = await env.app.inject({ method: 'POST', url: `/api/orders/${o.id}/request-bill`, headers: { cookie: c.cookie, 'x-requested-with': 'rms', 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(200);
    const bad = await env.app.inject({ method: 'POST', url: `/api/orders/${o.id}/reopen`, payload: '{not json', headers: { cookie: c.cookie, 'x-requested-with': 'rms', 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
  });

  it('does not force HTTPS upgrades or HSTS when served over plain HTTP', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, db: 'up' });
    expect(String(r.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    expect(r.headers['strict-transport-security']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('enables HTTPS-only headers and Secure cookies behind TLS', async () => {
    const secure = await createTestEnv({ env: { COOKIE_SECURE: 'true' } });
    const r = await secure.app.inject({ method: 'GET', url: '/api/health' });
    expect(String(r.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    const login = await secure.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@test.local', password: 'test-password-123' }, headers: { 'x-requested-with': 'rms' } });
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    await secure.close();
  });

  it('never returns stack traces or internals on unexpected errors', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/orders/not-a-uuid', headers: { cookie: (await env.as('CASHIER')).cookie } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/at .*\.ts:\d+/);
  });
});
