import { applyBps } from './money';

/** Promotion engine (SPEC §3.13). Pure: the server feeds it authoritative order data. */

export type PromotionType = 'PERCENT_BILL' | 'AMOUNT_BILL' | 'PERCENT_ITEM' | 'BUY_X_GET_Y';

export interface PromotionConditions {
  minSpendSatang?: number;
  menuItemIds?: string[];
  categoryIds?: string[];
  buyQty?: number;
  getQty?: number;
  /** Weekday bitmask Sun=1 … Sat=64. */
  days?: number;
  timeFrom?: string;
  timeTo?: string;
  branchIds?: string[];
  channels?: string[];
  memberOnly?: boolean;
  tiers?: string[];
}

export interface PromotionRule {
  id: string;
  name: string;
  type: PromotionType;
  /** bps for PERCENT_*, satang for AMOUNT_BILL, unused for BUY_X_GET_Y. */
  value: number;
  conditions: PromotionConditions;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
  stackable: boolean;
  active: boolean;
}

export interface PromoLine {
  menuItemId: string;
  categoryId: string | null;
  unitPriceSatang: number;
  qty: number;
}

export interface PromoContext {
  /** Bill amount after item discounts and before this promotion. */
  subtotalSatang: number;
  lines: PromoLine[];
  channel: string;
  branchId: string;
  localDay: number;
  localMinutes: number;
  now: Date;
  customer: { id: string; tier: string | null } | null;
  usage: { total: number; byCustomer: number };
  appliedPromotions: { id: string; stackable: boolean }[];
}

export type PromoResult = { ok: true; amountSatang: number } | { ok: false; reason: string };

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const fail = (reason: string): PromoResult => ({ ok: false, reason });

function matches(c: PromotionConditions, l: PromoLine) {
  const noFilter = !c.menuItemIds?.length && !c.categoryIds?.length;
  return noFilter || c.menuItemIds?.includes(l.menuItemId) || (!!l.categoryId && c.categoryIds?.includes(l.categoryId));
}

export function evaluatePromotion(p: PromotionRule, ctx: PromoContext): PromoResult {
  const c = p.conditions ?? {};
  if (!p.active) return fail('โปรโมชันนี้ปิดใช้งาน');
  if (p.startsAt && ctx.now < p.startsAt) return fail('โปรโมชันยังไม่เริ่ม');
  if (p.endsAt && ctx.now >= p.endsAt) return fail('โปรโมชันหมดอายุแล้ว');
  if (c.days !== undefined && (c.days & (1 << ctx.localDay)) === 0) return fail('ไม่ใช่วันที่ร่วมรายการ');
  if (c.timeFrom && c.timeTo) {
    const f = toMin(c.timeFrom);
    const t = toMin(c.timeTo);
    const inWindow = f <= t ? ctx.localMinutes >= f && ctx.localMinutes < t : ctx.localMinutes >= f || ctx.localMinutes < t;
    if (!inWindow) return fail('ไม่อยู่ในช่วงเวลาโปรโมชัน');
  }
  if (c.branchIds?.length && !c.branchIds.includes(ctx.branchId)) return fail('สาขานี้ไม่ร่วมรายการ');
  if (c.channels?.length && !c.channels.includes(ctx.channel)) return fail('ช่องทางนี้ไม่ร่วมรายการ');
  if ((c.memberOnly || c.tiers?.length || p.usageLimitPerCustomer) && !ctx.customer) return fail('เฉพาะสมาชิก — กรุณาระบุลูกค้า');
  if (c.tiers?.length && !c.tiers.includes(ctx.customer?.tier ?? '')) return fail('ระดับสมาชิกไม่ตรงเงื่อนไข');
  if (p.usageLimitTotal !== null && ctx.usage.total >= p.usageLimitTotal) return fail('โปรโมชันถูกใช้ครบจำนวนแล้ว');
  if (p.usageLimitPerCustomer !== null && ctx.usage.byCustomer >= p.usageLimitPerCustomer) return fail('ลูกค้าใช้สิทธิ์นี้ครบแล้ว');
  if (ctx.appliedPromotions.some((x) => x.id === p.id)) return fail('ใช้โปรโมชันนี้ในบิลแล้ว');
  if (ctx.appliedPromotions.length && (!p.stackable || ctx.appliedPromotions.some((x) => !x.stackable))) return fail('ใช้ร่วมกับโปรโมชันอื่นไม่ได้');
  if (c.minSpendSatang && ctx.subtotalSatang < c.minSpendSatang) return fail(`ยอดขั้นต่ำ ${(c.minSpendSatang / 100).toFixed(2)} บาท`);

  let amount = 0;
  switch (p.type) {
    case 'PERCENT_BILL':
      amount = applyBps(ctx.subtotalSatang, Math.min(10_000, p.value));
      break;
    case 'AMOUNT_BILL':
      amount = p.value;
      break;
    case 'PERCENT_ITEM': {
      const base = ctx.lines.filter((l) => matches(c, l)).reduce((a, l) => a + l.unitPriceSatang * l.qty, 0);
      if (base === 0) return fail('ไม่มีรายการที่ร่วมโปรโมชัน');
      amount = applyBps(base, Math.min(10_000, p.value));
      break;
    }
    case 'BUY_X_GET_Y': {
      const buy = c.buyQty ?? 0;
      const get = c.getQty ?? 0;
      if (buy < 1 || get < 1) return fail('ตั้งค่าโปรโมชันไม่ครบ');
      const units = ctx.lines.filter((l) => matches(c, l)).flatMap((l) => Array<number>(l.qty).fill(l.unitPriceSatang));
      const free = Math.floor(units.length / (buy + get)) * get;
      if (free === 0) return fail(`ซื้อครบ ${buy + get} ชิ้นเพื่อรับสิทธิ์`);
      amount = units.sort((a, b) => a - b).slice(0, free).reduce((a, v) => a + v, 0);
      break;
    }
  }
  amount = Math.min(amount, ctx.subtotalSatang);
  if (amount <= 0) return fail('ไม่มีส่วนลดจากโปรโมชันนี้');
  return { ok: true, amountSatang: amount };
}

export interface Tier {
  code: string;
  name: string;
  minSpendSatang: number;
  earnMultiplierBps: number;
}

/** Points for a paid amount: floor(paid / 100 THB × rate × multiplier). Integer maths via BigInt. */
export function pointsToEarn(paidSatang: number, pointsPer100Baht: number, multiplierBps: number): number {
  if (paidSatang <= 0 || pointsPer100Baht <= 0 || multiplierBps <= 0) return 0;
  return Number((BigInt(paidSatang) * BigInt(pointsPer100Baht) * BigInt(multiplierBps)) / 100_000_000n);
}

export function tierFor(lifetimeSpendSatang: number, tiers: Tier[]): Tier | null {
  return [...tiers].sort((a, b) => b.minSpendSatang - a.minSpendSatang).find((t) => lifetimeSpendSatang >= t.minSpendSatang) ?? null;
}
