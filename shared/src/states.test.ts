import { describe, expect, it } from 'vitest';
import { canTransition, ITEM_TRANSITIONS, ORDER_TRANSITIONS } from './states';

describe('state machines', () => {
  it('follows the documented order flow', () => {
    expect(canTransition(ORDER_TRANSITIONS, 'OPEN', 'BILL_REQUESTED')).toBe(true);
    expect(canTransition(ORDER_TRANSITIONS, 'BILL_REQUESTED', 'PAID')).toBe(true);
    expect(canTransition(ORDER_TRANSITIONS, 'PAID', 'CLOSED')).toBe(true);
    expect(canTransition(ORDER_TRANSITIONS, 'OPEN', 'VOIDED')).toBe(true);
    expect(canTransition(ORDER_TRANSITIONS, 'CLOSED', 'OPEN')).toBe(false);
    expect(canTransition(ORDER_TRANSITIONS, 'VOIDED', 'OPEN')).toBe(false);
    expect(canTransition(ORDER_TRANSITIONS, 'PAID', 'VOIDED')).toBe(false);
  });
  it('follows the documented item flow', () => {
    const path = ['PENDING', 'SENT', 'PREPARING', 'READY', 'SERVED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(ITEM_TRANSITIONS, path[i], path[i + 1])).toBe(true);
    expect(canTransition(ITEM_TRANSITIONS, 'SERVED', 'CANCELLED')).toBe(false);
    expect(canTransition(ITEM_TRANSITIONS, 'PENDING', 'READY')).toBe(false);
  });
});
