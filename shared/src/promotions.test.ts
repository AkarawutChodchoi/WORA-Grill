import { describe, expect, it } from 'vitest';
import { evaluatePromotion, pointsToEarn, tierFor, type PromoContext, type PromotionRule } from './promotions';

const base: PromotionRule = {
  id: 'p1',
  name: 'ลด 10%',
  type: 'PERCENT_BILL',
  value: 1000,
  conditions: {},
  startsAt: null,
  endsAt: null,
  usageLimitTotal: null,
  usageLimitPerCustomer: null,
  stackable: false,
  active: true,
};

const ctx = (over: Partial<PromoContext> = {}): PromoContext => ({
  subtotalSatang: 50000,
  lines: [
    { menuItemId: 'rice', categoryId: 'mains', unitPriceSatang: 9000, qty: 2 },
    { menuItemId: 'tea', categoryId: 'drinks', unitPriceSatang: 5500, qty: 4 },
    { menuItemId: 'water', categoryId: 'drinks', unitPriceSatang: 2000, qty: 5 },
  ],
  channel: 'DINE_IN',
  branchId: 'b1',
  localDay: 1, // Monday
  localMinutes: 12 * 60,
  now: new Date('2026-10-12T05:00:00Z'),
  customer: null,
  usage: { total: 0, byCustomer: 0 },
  appliedPromotions: [],
  ...over,
});

describe('evaluatePromotion', () => {
  it('percent off the bill', () => {
    const r = evaluatePromotion(base, ctx());
    expect(r).toEqual({ ok: true, amountSatang: 5000 });
  });

  it('fixed amount never exceeds the subtotal', () => {
    expect(evaluatePromotion({ ...base, type: 'AMOUNT_BILL', value: 99999999 }, ctx())).toEqual({ ok: true, amountSatang: 50000 });
  });

  it('minimum spend', () => {
    const p = { ...base, conditions: { minSpendSatang: 60000 } };
    expect(evaluatePromotion(p, ctx()).ok).toBe(false);
    expect(evaluatePromotion(p, ctx({ subtotalSatang: 60000 })).ok).toBe(true);
  });

  it('percent off matching items only', () => {
    const r = evaluatePromotion({ ...base, type: 'PERCENT_ITEM', value: 5000, conditions: { categoryIds: ['drinks'] } }, ctx());
    expect(r).toEqual({ ok: true, amountSatang: (5500 * 4 + 2000 * 5) / 2 });
  });

  it('buy 2 get 1 free gives the cheapest qualifying units', () => {
    const p: PromotionRule = { ...base, type: 'BUY_X_GET_Y', value: 0, conditions: { menuItemIds: ['tea', 'water'], buyQty: 2, getQty: 1 } };
    // 9 qualifying units → 3 free; cheapest three are water (20 each)
    expect(evaluatePromotion(p, ctx())).toEqual({ ok: true, amountSatang: 6000 });
    expect(evaluatePromotion(p, ctx({ lines: [{ menuItemId: 'tea', categoryId: 'drinks', unitPriceSatang: 5500, qty: 2 }] })).ok).toBe(false);
  });

  it('time, day, channel, branch and date-range restrictions', () => {
    const happy = { ...base, conditions: { timeFrom: '15:00', timeTo: '18:00' } };
    expect(evaluatePromotion(happy, ctx()).ok).toBe(false);
    expect(evaluatePromotion(happy, ctx({ localMinutes: 16 * 60 })).ok).toBe(true);
    expect(evaluatePromotion({ ...base, conditions: { days: 0b1000001 } }, ctx()).ok).toBe(false); // weekends only
    expect(evaluatePromotion({ ...base, conditions: { channels: ['TAKEAWAY'] } }, ctx()).ok).toBe(false);
    expect(evaluatePromotion({ ...base, conditions: { branchIds: ['b2'] } }, ctx()).ok).toBe(false);
    expect(evaluatePromotion({ ...base, endsAt: new Date('2026-10-01T00:00:00Z') }, ctx()).ok).toBe(false);
    expect(evaluatePromotion({ ...base, startsAt: new Date('2026-11-01T00:00:00Z') }, ctx()).ok).toBe(false);
    expect(evaluatePromotion({ ...base, active: false }, ctx()).ok).toBe(false);
  });

  it('member-only and tier restrictions', () => {
    const p = { ...base, conditions: { memberOnly: true, tiers: ['GOLD'] } };
    expect(evaluatePromotion(p, ctx()).ok).toBe(false);
    expect(evaluatePromotion(p, ctx({ customer: { id: 'c1', tier: 'SILVER' } })).ok).toBe(false);
    expect(evaluatePromotion(p, ctx({ customer: { id: 'c1', tier: 'GOLD' } })).ok).toBe(true);
  });

  it('usage limits', () => {
    expect(evaluatePromotion({ ...base, usageLimitTotal: 10 }, ctx({ usage: { total: 10, byCustomer: 0 } })).ok).toBe(false);
    const perCustomer = { ...base, usageLimitPerCustomer: 1 };
    expect(evaluatePromotion(perCustomer, ctx({ customer: { id: 'c', tier: null }, usage: { total: 3, byCustomer: 1 } })).ok).toBe(false);
    expect(evaluatePromotion(perCustomer, ctx()).ok).toBe(false); // per-customer limit needs a known customer
  });

  it('stacking rules', () => {
    expect(evaluatePromotion(base, ctx({ appliedPromotions: [{ id: 'x', stackable: true }] })).ok).toBe(false);
    expect(evaluatePromotion({ ...base, stackable: true }, ctx({ appliedPromotions: [{ id: 'x', stackable: false }] })).ok).toBe(false);
    expect(evaluatePromotion({ ...base, stackable: true }, ctx({ appliedPromotions: [{ id: 'x', stackable: true }] })).ok).toBe(true);
    expect(evaluatePromotion({ ...base, stackable: true }, ctx({ appliedPromotions: [{ id: 'p1', stackable: true }] })).ok).toBe(false); // same promo twice
  });
});

describe('loyalty maths', () => {
  it('earns points per 100 baht with a tier multiplier, rounding down', () => {
    expect(pointsToEarn(29425, 1, 10000)).toBe(2);
    expect(pointsToEarn(29425, 1, 15000)).toBe(4); // 2.94 × 1.5 = 4.4 → 4
    expect(pointsToEarn(9999, 1, 10000)).toBe(0);
  });
  it('chooses the highest tier reached by lifetime spend', () => {
    const tiers = [
      { code: 'SILVER', name: 'Silver', minSpendSatang: 100000, earnMultiplierBps: 10000 },
      { code: 'GOLD', name: 'Gold', minSpendSatang: 500000, earnMultiplierBps: 15000 },
    ];
    expect(tierFor(50000, tiers)).toBeNull();
    expect(tierFor(100000, tiers)?.code).toBe('SILVER');
    expect(tierFor(900000, tiers)?.code).toBe('GOLD');
  });
});
