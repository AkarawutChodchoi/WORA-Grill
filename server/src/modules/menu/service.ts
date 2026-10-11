import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  isInSchedule,
  resolvePrice,
  unitPriceWithModifiers,
  validateModifiers,
  type ModifierGroupRule,
  type ResolvedModifier,
  type SelectedModifier,
} from '@shared/menu';
import { resolveBranchSettings } from '@shared/settings';
import type { DbOrTx } from '../../db/client';
import {
  branches,
  comboComponents,
  menuCategories,
  menuItemBranch,
  menuItemModifierGroups,
  menuItemPrices,
  menuItems,
  modifierGroups,
  modifiers,
} from '../../db/schema';
import { notFound, unprocessable } from '../../lib/errors';

export interface BranchMenuItem {
  id: string;
  categoryId: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  nameEn: string | null;
  nameZh: string | null;
  description: string | null;
  descriptionEn: string | null;
  descriptionZh: string | null;
  imageUrl: string | null;
  priceSatang: number;
  stationCode: string | null;
  tags: string[];
  allergens: string[];
  defaultCourse: number;
  isCombo: boolean;
  hideOnQr: boolean;
  soldOut: boolean;
  available: boolean;
  unavailableReason: 'SOLD_OUT' | 'DISABLED' | 'SCHEDULE' | null;
  modifierGroups: ModifierGroupRule[];
  comboComponents: { itemId: string; name: string; qty: number }[];
  sort: number;
}

export interface BranchMenu {
  categories: { id: string; parentId: string | null; name: string; nameEn: string | null; nameZh: string | null; sort: number; stationCode: string | null }[];
  items: BranchMenuItem[];
}

/**
 * The sellable menu for one branch and channel: active categories/items with resolved price,
 * modifiers, combo components and availability (branch-disabled, sold out, time window).
 */
export async function loadBranchMenu(db: DbOrTx, p: { orgId: string; branchId: string; channel: string; at?: Date }): Promise<BranchMenu> {
  const [branch] = await db.select({ timezone: branches.timezone }).from(branches).where(and(eq(branches.id, p.branchId), eq(branches.organizationId, p.orgId)));
  if (!branch) throw notFound('สาขา');
  const at = p.at ?? new Date();
  const cats = await db
    .select()
    .from(menuCategories)
    .where(and(eq(menuCategories.organizationId, p.orgId), isNull(menuCategories.archivedAt)))
    .orderBy(asc(menuCategories.sort), asc(menuCategories.name));
  const items = await db
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, p.orgId), isNull(menuItems.archivedAt)))
    .orderBy(asc(menuItems.sort), asc(menuItems.name));
  const catIds = new Set(cats.map((c) => c.id));
  const live = items.filter((i) => catIds.has(i.categoryId));
  const ids = live.map((i) => i.id);
  if (ids.length === 0) return { categories: cats.map(pickCat), items: [] };

  const [prices, states, links, combos] = await Promise.all([
    db.select().from(menuItemPrices).where(inArray(menuItemPrices.menuItemId, ids)),
    db.select().from(menuItemBranch).where(and(inArray(menuItemBranch.menuItemId, ids), eq(menuItemBranch.branchId, p.branchId))),
    db.select().from(menuItemModifierGroups).where(inArray(menuItemModifierGroups.menuItemId, ids)).orderBy(asc(menuItemModifierGroups.sort)),
    db.select().from(comboComponents).where(inArray(comboComponents.comboItemId, ids)).orderBy(asc(comboComponents.sort)),
  ]);
  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const groups = groupIds.length ? await db.select().from(modifierGroups).where(and(inArray(modifierGroups.id, groupIds), isNull(modifierGroups.archivedAt))) : [];
  const mods = groupIds.length
    ? await db.select().from(modifiers).where(and(inArray(modifiers.groupId, groupIds), isNull(modifiers.archivedAt))).orderBy(asc(modifiers.sort))
    : [];
  const groupRule = new Map<string, ModifierGroupRule>(
    groups.map((g) => [
      g.id,
      {
        id: g.id,
        name: g.name,
        nameEn: g.nameEn,
        nameZh: g.nameZh,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        allowRepeat: g.allowRepeat,
        modifiers: mods.filter((m) => m.groupId === g.id).map((m) => ({ id: m.id, name: m.name, nameEn: m.nameEn, nameZh: m.nameZh, priceDeltaSatang: m.priceDeltaSatang, isDefault: m.isDefault })),
      },
    ]),
  );
  const nameById = new Map(items.map((i) => [i.id, i.name]));
  const catStation = new Map(cats.map((c) => [c.id, c.stationCode]));

  return {
    categories: cats.map(pickCat),
    items: live.map((i) => {
      const st = states.find((s) => s.menuItemId === i.id);
      const disabled = st ? !st.isEnabled : false;
      const soldOut = st?.soldOut ?? false;
      const inTime = isInSchedule(i, at, branch.timezone);
      const unavailableReason = disabled ? 'DISABLED' : soldOut ? 'SOLD_OUT' : !inTime ? 'SCHEDULE' : null;
      return {
        id: i.id,
        categoryId: i.categoryId,
        sku: i.sku,
        barcode: i.barcode,
        name: i.name,
        nameEn: i.nameEn,
        nameZh: i.nameZh,
        description: i.description,
        descriptionEn: i.descriptionEn,
        descriptionZh: i.descriptionZh,
        imageUrl: i.imageUrl,
        priceSatang: resolvePrice(
          i.priceSatang,
          prices.filter((x) => x.menuItemId === i.id),
          { branchId: p.branchId, channel: p.channel },
        ),
        stationCode: i.stationCode ?? catStation.get(i.categoryId) ?? null,
        tags: i.tags,
        allergens: i.allergens,
        defaultCourse: i.defaultCourse,
        isCombo: i.isCombo,
        hideOnQr: i.hideOnQr,
        soldOut,
        available: unavailableReason === null,
        unavailableReason,
        modifierGroups: links.filter((l) => l.menuItemId === i.id && groupRule.has(l.groupId)).map((l) => groupRule.get(l.groupId)!),
        comboComponents: combos.filter((c) => c.comboItemId === i.id).map((c) => ({ itemId: c.componentItemId, name: nameById.get(c.componentItemId) ?? '?', qty: c.qty })),
        sort: i.sort,
      };
    }),
  };
}

function pickCat(c: typeof menuCategories.$inferSelect) {
  return { id: c.id, parentId: c.parentId, name: c.name, nameEn: c.nameEn, nameZh: c.nameZh, sort: c.sort, stationCode: c.stationCode };
}

export interface OrderLineInput {
  menuItemId: string;
  qty: number;
  modifiers?: SelectedModifier[];
}

export interface ResolvedLine {
  menuItemId: string;
  name: string;
  nameEn: string | null;
  basePriceSatang: number;
  unitPriceSatang: number;
  modifiers: ResolvedModifier[];
  stationCode: string | null;
  course: number;
  allergens: string[];
  comboComponents: { itemId: string; name: string; qty: number }[];
}

/**
 * Server-side validation of an order line against the live branch menu: the item must exist, be
 * sellable now, and the modifier selection must satisfy the group rules. Prices come from the server.
 */
export function resolveLine(menu: BranchMenu, line: OrderLineInput): ResolvedLine {
  const item = menu.items.find((i) => i.id === line.menuItemId);
  if (!item) throw notFound('เมนู');
  if (!item.available) {
    const why = item.unavailableReason === 'SOLD_OUT' ? 'หมด' : item.unavailableReason === 'SCHEDULE' ? 'ไม่อยู่ในช่วงเวลาขาย' : 'ปิดขายในสาขานี้';
    throw unprocessable(`"${item.name}" ${why}`, 'ITEM_UNAVAILABLE', { menuItemId: item.id, reason: item.unavailableReason });
  }
  const v = validateModifiers(item.modifierGroups, line.modifiers ?? []);
  if (!v.ok) throw unprocessable(`${item.name}: ${v.errors.join(', ')}`, 'INVALID_MODIFIERS', v.errors);
  return {
    menuItemId: item.id,
    name: item.name,
    nameEn: item.nameEn,
    basePriceSatang: item.priceSatang,
    unitPriceSatang: unitPriceWithModifiers(item.priceSatang, v.modifiers),
    modifiers: v.modifiers,
    stationCode: item.stationCode,
    course: item.defaultCourse,
    allergens: item.allergens,
    comboComponents: item.comboComponents,
  };
}

export async function branchSettings(db: DbOrTx, branchId: string) {
  const [b] = await db.select({ settings: branches.settings, timezone: branches.timezone }).from(branches).where(eq(branches.id, branchId));
  if (!b) throw notFound('สาขา');
  return { ...resolveBranchSettings(b.settings), timezone: b.timezone };
}
