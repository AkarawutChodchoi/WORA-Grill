import { describe, expect, it } from 'vitest';
import { computeTotals, type PricingConfig } from './pricing';

const EXCL: PricingConfig = { vatMode: 'EXCLUSIVE', vatBps: 700, serviceChargeBps: 1000, serviceChargeTaxable: true };
const INCL: PricingConfig = { vatMode: 'INCLUSIVE', vatBps: 700, serviceChargeBps: 0, serviceChargeTaxable: true };

const line = (unit: number, qty = 1, extra: Partial<{ discountSatang: number; status: string }> = {}) => ({ unitPriceSatang: unit, qty, discountSatang: 0, status: 'SENT', ...extra });

describe('computeTotals', () => {
  it('adds 10% service charge then 7% VAT on top (exclusive)', () => {
    const t = computeTotals([line(10000), line(5000, 2)], [], EXCL);
    expect(t.subtotalSatang).toBe(20000);
    expect(t.serviceChargeSatang).toBe(2000);
    expect(t.vatSatang).toBe(1540); // 7% of 22000
    expect(t.grandTotalSatang).toBe(23540);
  });

  it('extracts VAT from inclusive prices without changing the total', () => {
    const t = computeTotals([line(10700)], [], INCL);
    expect(t.vatSatang).toBe(700);
    expect(t.grandTotalSatang).toBe(10700);
  });

  it('ignores cancelled lines', () => {
    const t = computeTotals([line(10000), line(99900, 1, { status: 'CANCELLED' })], [], { ...EXCL, serviceChargeBps: 0, vatMode: 'NONE' });
    expect(t.grandTotalSatang).toBe(10000);
  });

  it('applies item discounts, then bill percent and amount discounts on the remaining subtotal', () => {
    const t = computeTotals(
      [line(10000, 1, { discountSatang: 1000 }), line(10000)],
      [
        { type: 'PERCENT', value: 1000 },
        { type: 'AMOUNT', value: 500 },
      ],
      { ...EXCL, vatMode: 'NONE', serviceChargeBps: 0 },
    );
    expect(t.itemDiscountSatang).toBe(1000);
    expect(t.billDiscountSatang).toBe(1900 + 500); // 10% of 19000, then 5 THB
    expect(t.discountSatang).toBe(3400);
    expect(t.grandTotalSatang).toBe(20000 - 3400);
  });

  it('never discounts below zero', () => {
    const t = computeTotals([line(1000, 1, { discountSatang: 5000 })], [{ type: 'AMOUNT', value: 99999 }], EXCL);
    expect(t.grandTotalSatang).toBe(0);
    expect(t.discountSatang).toBe(1000);
  });

  it('service charge is computed after discounts; VAT excludes service when not taxable', () => {
    const t = computeTotals([line(10000)], [{ type: 'PERCENT', value: 5000 }], { ...EXCL, serviceChargeTaxable: false });
    expect(t.serviceChargeSatang).toBe(500);
    expect(t.vatSatang).toBe(350);
    expect(t.grandTotalSatang).toBe(5000 + 500 + 350);
  });

  it('keeps everything in whole satang', () => {
    const t = computeTotals([line(3333, 3)], [{ type: 'PERCENT', value: 333 }], EXCL);
    for (const v of Object.values(t)) expect(Number.isInteger(v)).toBe(true);
  });
});
