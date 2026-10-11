/** Pure menu rules shared by POS, QR menu and server validation (SPEC §3.7). */

export interface PriceOverride {
  branchId: string | null;
  channel: string | null;
  priceSatang: number;
}

/** Most specific price wins: branch+channel → branch → channel → base. */
export function resolvePrice(basePriceSatang: number, overrides: PriceOverride[], ctx: { branchId: string; channel: string }): number {
  const pick = (b: string | null, c: string | null) => overrides.find((o) => o.branchId === b && o.channel === c);
  return (pick(ctx.branchId, ctx.channel) ?? pick(ctx.branchId, null) ?? pick(null, ctx.channel) ?? { priceSatang: basePriceSatang }).priceSatang;
}

export interface ModifierGroupRule {
  id: string;
  name: string;
  nameEn?: string | null;
  nameZh?: string | null;
  minSelect: number;
  maxSelect: number;
  allowRepeat: boolean;
  modifiers: { id: string; name: string; nameEn?: string | null; nameZh?: string | null; priceDeltaSatang: number; isDefault?: boolean; archived?: boolean }[];
}

export interface SelectedModifier {
  modifierId: string;
  qty?: number;
}

export interface ResolvedModifier {
  groupId: string;
  groupName: string;
  modifierId: string;
  name: string;
  qty: number;
  priceDeltaSatang: number;
}

/**
 * Validate a modifier selection against the item's groups. Returns resolved modifiers (with
 * authoritative prices) or a list of human-readable errors.
 */
export function validateModifiers(groups: ModifierGroupRule[], selected: SelectedModifier[]): { ok: true; modifiers: ResolvedModifier[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const resolved: ResolvedModifier[] = [];
  const byId = new Map<string, { g: ModifierGroupRule; m: ModifierGroupRule['modifiers'][number] }>();
  for (const g of groups) for (const m of g.modifiers) byId.set(m.id, { g, m });

  const seen = new Map<string, number>();
  for (const s of selected) {
    const qty = s.qty ?? 1;
    const hit = byId.get(s.modifierId);
    if (!hit) {
      errors.push('มีตัวเลือกที่ไม่ได้อยู่ในเมนูนี้');
      continue;
    }
    if (hit.m.archived) {
      errors.push(`ตัวเลือก "${hit.m.name}" ไม่มีขายแล้ว`);
      continue;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      errors.push(`จำนวนของ "${hit.m.name}" ไม่ถูกต้อง`);
      continue;
    }
    const prev = seen.get(s.modifierId) ?? 0;
    if ((prev > 0 || qty > 1) && !hit.g.allowRepeat) {
      errors.push(`เลือก "${hit.m.name}" ซ้ำไม่ได้`);
      continue;
    }
    seen.set(s.modifierId, prev + qty);
    const existing = resolved.find((r) => r.modifierId === s.modifierId);
    if (existing) existing.qty += qty;
    else resolved.push({ groupId: hit.g.id, groupName: hit.g.name, modifierId: hit.m.id, name: hit.m.name, qty, priceDeltaSatang: hit.m.priceDeltaSatang });
  }
  for (const g of groups) {
    const n = resolved.filter((r) => r.groupId === g.id).reduce((a, r) => a + r.qty, 0);
    if (n < g.minSelect) errors.push(g.minSelect === 1 ? `กรุณาเลือก "${g.name}"` : `"${g.name}" ต้องเลือกอย่างน้อย ${g.minSelect} อย่าง`);
    if (g.maxSelect > 0 && n > g.maxSelect) errors.push(`"${g.name}" เลือกได้ไม่เกิน ${g.maxSelect} อย่าง`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, modifiers: resolved };
}

/** Unit price of one item including modifiers (never negative). */
export function unitPriceWithModifiers(itemPriceSatang: number, mods: Pick<ResolvedModifier, 'priceDeltaSatang' | 'qty'>[]): number {
  return Math.max(0, itemPriceSatang + mods.reduce((a, m) => a + m.priceDeltaSatang * m.qty, 0));
}

export interface Schedule {
  availableDays: number;
  availableFrom: string | null;
  availableTo: string | null;
}

/** Local wall-clock parts of `at` in a timezone. */
export function localParts(at: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const wd = parts.find((p) => p.type === 'weekday')!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return { day, minutes: h * 60 + m };
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Time-based availability (breakfast menu, happy hour). Windows may cross midnight. */
export function isInSchedule(s: Schedule, at: Date, timeZone: string): boolean {
  const { day, minutes } = localParts(at, timeZone);
  if ((s.availableDays & (1 << day)) === 0) return false;
  if (!s.availableFrom || !s.availableTo) return true;
  const from = toMin(s.availableFrom);
  const to = toMin(s.availableTo);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export const MENU_TAGS: Record<string, string> = { spicy: 'เผ็ด', vegetarian: 'มังสวิรัติ', vegan: 'วีแกน', halal: 'ฮาลาล', signature: 'เมนูแนะนำ', new: 'ใหม่' };
export const ALLERGENS: Record<string, string> = {
  peanut: 'ถั่วลิสง',
  treenut: 'ถั่วเปลือกแข็ง',
  shellfish: 'อาหารทะเลมีเปลือก',
  fish: 'ปลา',
  egg: 'ไข่',
  milk: 'นม',
  gluten: 'กลูเตน/แป้งสาลี',
  soy: 'ถั่วเหลือง',
  sesame: 'งา',
};
