import { describe, expect, it } from 'vitest';
import { isInSchedule, resolvePrice, unitPriceWithModifiers, validateModifiers, type ModifierGroupRule } from './menu';

describe('resolvePrice', () => {
  const overrides = [
    { branchId: null, channel: 'GRAB', priceSatang: 12000 },
    { branchId: 'b1', channel: null, priceSatang: 9500 },
    { branchId: 'b1', channel: 'GRAB', priceSatang: 13000 },
  ];
  it('picks the most specific override', () => {
    expect(resolvePrice(10000, overrides, { branchId: 'b1', channel: 'GRAB' })).toBe(13000);
    expect(resolvePrice(10000, overrides, { branchId: 'b1', channel: 'DINE_IN' })).toBe(9500);
    expect(resolvePrice(10000, overrides, { branchId: 'b2', channel: 'GRAB' })).toBe(12000);
    expect(resolvePrice(10000, overrides, { branchId: 'b2', channel: 'DINE_IN' })).toBe(10000);
  });
});

describe('validateModifiers', () => {
  const spice: ModifierGroupRule = {
    id: 'g1',
    name: 'ระดับความเผ็ด',
    minSelect: 1,
    maxSelect: 1,
    allowRepeat: false,
    modifiers: [
      { id: 'm1', name: 'ไม่เผ็ด', priceDeltaSatang: 0 },
      { id: 'm2', name: 'เผ็ดมาก', priceDeltaSatang: 0 },
    ],
  };
  const extras: ModifierGroupRule = {
    id: 'g2',
    name: 'ท็อปปิ้ง',
    minSelect: 0,
    maxSelect: 3,
    allowRepeat: true,
    modifiers: [
      { id: 'e1', name: 'ไข่ดาว', priceDeltaSatang: 1000 },
      { id: 'e2', name: 'กุ้ง', priceDeltaSatang: 3000 },
      { id: 'e3', name: 'เลิกขาย', priceDeltaSatang: 500, archived: true },
    ],
  };

  it('requires mandatory groups', () => {
    const r = validateModifiers([spice, extras], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('ระดับความเผ็ด');
  });
  it('enforces max selection', () => {
    const r = validateModifiers([spice], [{ modifierId: 'm1' }, { modifierId: 'm2' }]);
    expect(r.ok).toBe(false);
  });
  it('rejects modifiers from other items and archived ones', () => {
    expect(validateModifiers([spice], [{ modifierId: 'm1' }, { modifierId: 'zzz' }]).ok).toBe(false);
    expect(validateModifiers([spice, extras], [{ modifierId: 'm1' }, { modifierId: 'e3' }]).ok).toBe(false);
  });
  it('allows repeats only when the group permits', () => {
    const r = validateModifiers([spice, extras], [{ modifierId: 'm1' }, { modifierId: 'e1', qty: 2 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(unitPriceWithModifiers(5000, r.modifiers)).toBe(7000);
    expect(validateModifiers([spice], [{ modifierId: 'm1', qty: 2 }]).ok).toBe(false);
    expect(validateModifiers([spice, extras], [{ modifierId: 'm1' }, { modifierId: 'e1', qty: 2 }, { modifierId: 'e2', qty: 2 }]).ok).toBe(false);
  });
  it('never yields a negative unit price', () => {
    expect(unitPriceWithModifiers(1000, [{ priceDeltaSatang: -5000, qty: 1 }])).toBe(0);
  });
});

describe('isInSchedule', () => {
  // 2026-10-12 is a Monday. 01:00 UTC = 08:00 Bangkok.
  const mondayMorning = new Date('2026-10-12T01:00:00Z');
  it('honours weekday mask', () => {
    expect(isInSchedule({ availableDays: 127, availableFrom: null, availableTo: null }, mondayMorning, 'Asia/Bangkok')).toBe(true);
    expect(isInSchedule({ availableDays: 1 /* Sunday only */, availableFrom: null, availableTo: null }, mondayMorning, 'Asia/Bangkok')).toBe(false);
  });
  it('honours time windows, including ones that cross midnight', () => {
    expect(isInSchedule({ availableDays: 127, availableFrom: '06:00', availableTo: '10:30' }, mondayMorning, 'Asia/Bangkok')).toBe(true);
    expect(isInSchedule({ availableDays: 127, availableFrom: '17:00', availableTo: '19:00' }, mondayMorning, 'Asia/Bangkok')).toBe(false);
    expect(isInSchedule({ availableDays: 127, availableFrom: '22:00', availableTo: '09:00' }, mondayMorning, 'Asia/Bangkok')).toBe(true);
  });
});
