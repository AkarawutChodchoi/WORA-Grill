import { describe, expect, it } from 'vitest';
import { isOfflineCapable, MemoryStore, Outbox, type OutboxEntry } from './outbox';

function server(script: Record<string, ('ok' | 'down' | 'conflict')[]>) {
  const calls: string[] = [];
  const send = async (e: OutboxEntry) => {
    calls.push(e.label);
    const next = script[e.label]?.shift() ?? 'ok';
    if (next === 'ok') return { ok: true as const };
    if (next === 'down') return { ok: false as const, retry: true, error: 'network' };
    return { ok: false as const, retry: false, error: 'บิลชำระแล้ว' };
  };
  return { send, calls };
}

describe('offline outbox', () => {
  it('only queues idempotent POS writes', () => {
    expect(isOfflineCapable('POST', '/orders')).toBe(true);
    expect(isOfflineCapable('POST', '/orders/abc/items')).toBe(true);
    expect(isOfflineCapable('POST', '/orders/abc/payments')).toBe(true);
    expect(isOfflineCapable('POST', '/orders/abc/void')).toBe(false);
    expect(isOfflineCapable('GET', '/orders/abc/items')).toBe(false);
  });

  it('replays in order and stops on network failure, resuming later without duplicates', async () => {
    const s = server({ items: ['ok'], send: ['down', 'ok'] });
    const box = new Outbox(new MemoryStore(), s.send);
    await box.enqueue('/orders/o1/items', {}, 'items');
    await box.enqueue('/orders/o1/send', {}, 'send');
    await box.enqueue('/orders/o1/payments', {}, 'pay');
    expect(await box.sync()).toEqual({ sent: 1, failed: 0, remaining: 2 });
    expect(await box.sync()).toEqual({ sent: 2, failed: 0, remaining: 0 });
    expect(s.calls).toEqual(['items', 'send', 'send', 'pay']);
  });

  it('a server rejection is kept for review and blocks later steps of the same bill only', async () => {
    const s = server({ pay1: ['conflict'] });
    const box = new Outbox(new MemoryStore(), s.send);
    await box.enqueue('/orders/o1/payments', {}, 'pay1');
    await box.enqueue('/orders/o1/send', {}, 'after-pay1');
    await box.enqueue('/orders/o2/items', {}, 'other-bill');
    const r = await box.sync();
    expect(r).toEqual({ sent: 1, failed: 1, remaining: 2 });
    expect(s.calls).toEqual(['pay1', 'other-bill']);
    const failed = (await box.entries()).find((e) => e.status === 'FAILED')!;
    expect(failed.error).toBe('บิลชำระแล้ว');
    await box.discard(failed.id);
    expect((await box.sync()).sent).toBe(1); // the held-back step proceeds
  });
});
