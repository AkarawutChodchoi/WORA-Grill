import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
  await env.app.ready();
});
afterAll(async () => env.close());

function collect(ws: any): { msgs: any[]; wait: (n: number) => Promise<void> } {
  const msgs: any[] = [];
  ws.on('message', (d: Buffer) => msgs.push(JSON.parse(d.toString())));
  return {
    msgs,
    wait: async (n) => {
      for (let i = 0; i < 50 && msgs.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    },
  };
}

describe('realtime gateway', () => {
  it('rejects anonymous sockets', async () => {
    const ws = await (env.app as any).injectWS('/api/ws');
    const code = await new Promise<number>((r) => ws.on('close', (c: number) => r(c)));
    expect(code).toBe(4401);
  });

  it('rejects cross-site WebSocket connections even with a valid cookie', async () => {
    const c = await env.as('WAITER');
    const ws = await (env.app as any).injectWS('/api/ws', { headers: { cookie: c.cookie, origin: 'https://evil.example', host: 'pos.example' } });
    const code = await new Promise<number>((r) => ws.on('close', (x: number) => r(x)));
    expect(code).toBe(4403);
  });

  it('forwards only events for the session organisation and branch', async () => {
    const c = await env.as('WAITER');
    let box!: ReturnType<typeof collect>;
    const ws = await (env.app as any).injectWS('/api/ws', { headers: { cookie: c.cookie } }, { onInit: (w: any) => (box = collect(w)) });
    await box.wait(1);
    expect(box.msgs[0].type).toBe('hello');
    env.bus.publish({ type: 'table.status_changed', organizationId: env.orgId, branchId: randomUUID(), payload: { x: 'other-branch' } });
    env.bus.publish({ type: 'table.status_changed', organizationId: randomUUID(), branchId: env.branchId, payload: { x: 'other-org' } });
    env.bus.publish({ type: 'table.status_changed', organizationId: env.orgId, branchId: env.branchId, payload: { x: 'mine' } });
    env.bus.publish({ type: 'menu.updated', organizationId: env.orgId, branchId: null, payload: { x: 'org-wide' } });
    await box.wait(3);
    expect(box.msgs.slice(1).map((m) => m.payload.x)).toEqual(['mine', 'org-wide']);
    ws.terminate();
  });
});
