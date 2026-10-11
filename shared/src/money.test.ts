import { describe, expect, it } from 'vitest';
import { allocate, applyBps, divRound, formatBaht, splitEvenly, toSatang, vatFromInclusive } from './money';

describe('money', () => {
  it('parses baht strings to satang without float error', () => {
    expect(toSatang('0.1')).toBe(10);
    expect(toSatang('19.99')).toBe(1999);
    expect(toSatang('1,234.5')).toBe(123450);
    expect(toSatang(0.3)).toBe(30);
    expect(toSatang('-5')).toBe(-500);
    expect(() => toSatang('1.234')).toThrow();
    expect(() => toSatang('abc')).toThrow();
  });
  it('rounds half away from zero', () => {
    expect(divRound(5, 10)).toBe(1);
    expect(divRound(4, 10)).toBe(0);
    expect(divRound(-5, 10)).toBe(-1);
  });
  it('applies basis points', () => {
    expect(applyBps(10000, 700)).toBe(700); // 7% of 100 THB
    expect(applyBps(9999, 700)).toBe(700); // 699.93 -> 700
    expect(applyBps(10050, 1000)).toBe(1005);
  });
  it('extracts VAT from an inclusive amount', () => {
    expect(vatFromInclusive(10700, 700)).toBe(700);
    expect(vatFromInclusive(100, 700)).toBe(7); // 6.54 -> 7
  });
  it('splits and allocates exactly', () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(1000, 3).reduce((a, b) => a + b)).toBe(1000);
    const a = allocate(1001, [1, 1, 2]);
    expect(a.reduce((x, y) => x + y)).toBe(1001);
    expect(allocate(500, [0, 0])).toEqual([250, 250]);
  });
  it('formats baht', () => {
    expect(formatBaht(123456)).toBe('฿1,234.56');
    expect(formatBaht(-5)).toBe('-฿0.05');
  });
});
