import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, users } from '../src/db/schema';
import { authorizeSensitive, loadAuth } from '../src/lib/auth';
import { Client, createTestEnv, TEST_PASSWORD, TEST_PIN, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

describe('authentication', () => {
  it('rejects unauthenticated access', async () => {
    const r = await env.anon().get('/auth/me');
    expect(r.status).toBe(401);
  });

  it('logs in with email/password and returns permissions for the branch', async () => {
    const c = await env.as('CASHIER');
    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(['CASHIER']);
    expect(me.body.permissions).toContain('payment.take');
    expect(me.body.permissions).not.toContain('order.void');
    expect(me.body.branch.id).toBe(env.branchId);
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const a = await env.anon().post('/auth/login', { email: 'nobody@test.local', password: 'x' });
    const b = await env.anon().post('/auth/login', { email: 'waiter@test.local', password: 'wrong-password' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i++) await env.anon().post('/auth/login', { email: 'storekeeper@test.local', password: 'bad-password' });
    const r = await env.anon().post('/auth/login', { email: 'storekeeper@test.local', password: TEST_PASSWORD });
    expect(r.status).toBe(423);
    await env.db.update(users).set({ lockedUntil: null, failedLoginCount: 0 }).where(eq(users.id, env.userIds.STOREKEEPER));
  });

  it('requires the CSRF header on mutations', async () => {
    const c = await env.as('OWNER');
    const r = await c.req('POST', '/auth/logout', {}, { 'x-requested-with': '' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF');
  });

  it('logout revokes the session', async () => {
    const c = new Client(env.app);
    await c.post('/auth/login', { email: 'kitchen@test.local', password: TEST_PASSWORD });
    const cookie = c.cookie;
    expect((await c.post('/auth/logout')).status).toBe(200);
    const stale = new Client(env.app, cookie);
    expect((await stale.get('/auth/me')).status).toBe(401);
  });

  it('records login in the audit log without secrets', async () => {
    const rows = await env.db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.login'));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(TEST_PASSWORD);
  });

  it('refuses a second setup once an organisation exists', async () => {
    const r = await env.anon().post('/setup', { orgName: 'x', branchName: 'y', ownerName: 'z', email: 'a@b.co', password: 'long-enough-pass' });
    expect(r.status).toBe(409);
  });
});

describe('PIN sign-in on a paired terminal', () => {
  it('requires a paired device', async () => {
    const r = await env.anon().get('/auth/pin-users');
    expect(r.status).toBe(403);
  });

  it('pairs a device, lists staff, and signs in with PIN', async () => {
    const mgr = await env.as('MANAGER');
    const pair = await mgr.post('/auth/terminal', { name: 'POS 1', kind: 'POS' });
    expect(pair.status).toBe(200);
    const deviceCookie = mgr.cookie.split('; ').find((c) => c.startsWith('rms_device='))!;
    const terminal = new Client(env.app, deviceCookie);
    const list = await terminal.get('/auth/pin-users');
    expect(list.status).toBe(200);
    expect(list.body.users.map((u: any) => u.id)).toContain(env.userIds.WAITER);
    expect(JSON.stringify(list.body)).not.toContain('pinHash');

    const bad = await terminal.post('/auth/pin-login', { userId: env.userIds.WAITER, pin: '0000' });
    expect(bad.status).toBe(401);
    const ok = await terminal.post('/auth/pin-login', { userId: env.userIds.WAITER, pin: TEST_PIN });
    expect(ok.status).toBe(200);
    const me = await terminal.get('/auth/me');
    expect(me.body.sessionKind).toBe('PIN');
    expect(me.body.user.id).toBe(env.userIds.WAITER);
    // a PIN session is pinned to the device's branch
    expect((await terminal.post('/auth/branch', { branchId: env.branchId })).status).toBe(403);
  });

  it('a waiter cannot pair devices', async () => {
    const w = await env.as('WAITER');
    expect((await w.post('/auth/terminal', { name: 'x' })).status).toBe(403);
  });
});

describe('authorisation', () => {
  it('denies user management to non-managers and allows it to managers', async () => {
    expect((await (await env.as('WAITER')).get('/users')).status).toBe(403);
    expect((await (await env.as('CASHIER')).get('/audit-logs')).status).toBe(403);
    const r = await (await env.as('MANAGER')).get('/users');
    expect(r.status).toBe(200);
    // branch manager does not see the org-wide owner
    expect(r.body.users.map((u: any) => u.id)).not.toContain(env.userIds.OWNER);
  });

  it('prevents privilege escalation when granting roles', async () => {
    const mgr = await env.as('MANAGER');
    const ownerRole = await mgr.post('/users', { name: 'X', pin: '1234', roles: [{ roleId: env.roleIds.OWNER, branchId: env.branchId }] });
    expect(ownerRole.status).toBe(403);
    const orgWide = await mgr.post('/users', { name: 'Y', pin: '1234', roles: [{ roleId: env.roleIds.WAITER, branchId: null }] });
    expect(orgWide.status).toBe(403);
    const ok = await mgr.post('/users', { name: 'New waiter', pin: '1357', roles: [{ roleId: env.roleIds.WAITER, branchId: env.branchId }] });
    expect(ok.status).toBe(200);
  });

  it('manager cannot modify the owner; owner can create a custom role', async () => {
    const mgr = await env.as('MANAGER');
    expect((await mgr.patch(`/users/${env.userIds.OWNER}`, { name: 'hacked' })).status).toBe(403);
    const owner = await env.as('OWNER');
    const r = await owner.post('/roles', { code: 'HOST', name: 'พนักงานต้อนรับ', permissions: ['reservation.manage', 'table.view'] });
    expect(r.status).toBe(200);
    expect((await owner.get('/roles')).body.roles.find((x: any) => x.code === 'HOST').permissions).toEqual(expect.arrayContaining(['reservation.manage']));
  });

  it('deactivating a user revokes their sessions', async () => {
    const owner = await env.as('OWNER');
    const c = new Client(env.app);
    await c.post('/auth/login', { email: 'storekeeper@test.local', password: TEST_PASSWORD });
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await owner.patch(`/users/${env.userIds.STOREKEEPER}`, { isActive: false })).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(401);
    await owner.patch(`/users/${env.userIds.STOREKEEPER}`, { isActive: true });
  });
});

describe('manager PIN approval', () => {
  it('passes directly when the actor holds the permission', async () => {
    const c = await env.as('MANAGER');
    const auth = await loadAuth(env.db, decodeURIComponent(c.cookie.split('rms_session=')[1].split(';')[0]));
    expect(await authorizeSensitive(env.db, auth!, 'order.void')).toBeNull();
  });

  it('requires a valid approver PIN when the actor lacks the permission', async () => {
    const c = await env.as('CASHIER');
    const auth = (await loadAuth(env.db, decodeURIComponent(c.cookie.split('rms_session=')[1].split(';')[0])))!;
    await expect(authorizeSensitive(env.db, auth, 'order.void')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeSensitive(env.db, auth, 'order.void', { userId: env.userIds.MANAGER, pin: '9999' })).rejects.toMatchObject({ status: 403 });
    // a waiter's PIN is not enough: waiters cannot void
    await expect(authorizeSensitive(env.db, auth, 'order.void', { userId: env.userIds.WAITER, pin: TEST_PIN })).rejects.toMatchObject({ status: 403 });
    expect(await authorizeSensitive(env.db, auth, 'order.void', { userId: env.userIds.MANAGER, pin: TEST_PIN })).toBe(env.userIds.MANAGER);
  });

  it('lists approvers for a permission', async () => {
    const c = await env.as('CASHIER');
    const r = await c.get('/auth/approvers?permission=order.void');
    const ids = r.body.approvers.map((a: any) => a.id);
    expect(ids).toContain(env.userIds.MANAGER);
    expect(ids).not.toContain(env.userIds.WAITER);
  });
});
