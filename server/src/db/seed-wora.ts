import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { storeImage } from '../lib/uploads';
import type { DbOrTx } from './client';
import { menuCategories, menuItemModifierGroups, menuItems, modifierGroups, modifiers, stations } from './schema';

/**
 * WORA Grill sample menu: 50 dishes with photos and options, taken from the owner's workbook
 * (`server/src/db/wora/menu.json` + `images/`). The photos are Wikimedia Commons samples for
 * testing only — replace them with the restaurant's own photos before going live.
 */
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wora');

interface WoraOption {
  name: string;
  nameEn: string | null;
  priceDelta: number;
}
interface WoraGroup {
  name: string;
  nameEn: string | null;
  min: number;
  max: number;
  options: WoraOption[];
}
interface WoraItem {
  sku: string;
  name: string;
  nameEn: string;
  category: string;
  price: number;
  description: string;
  tags: string[];
  allergens: string[];
  image: string | null;
  groups: WoraGroup[];
}
interface WoraMenu {
  categories: { name: string; nameEn: string | null }[];
  items: WoraItem[];
}

const STATIONS = [
  { code: 'HOT', name: 'ครัวร้อน', sort: 10 },
  { code: 'GRILL', name: 'เตาย่าง / ยำ', sort: 20 },
  { code: 'BAR', name: 'บาร์น้ำ', sort: 30 },
  { code: 'DESSERT', name: 'ของหวาน', sort: 40 },
  { code: 'EXPO', name: 'Expo ตรวจก่อนเสิร์ฟ', sort: 50, isExpo: true },
];
const CATEGORY_STATION: Record<string, string> = { 'ยำ / อีสาน': 'GRILL', ของหวาน: 'DESSERT', เครื่องดื่ม: 'BAR' };
const CATEGORY_COURSE: Record<string, number> = { 'ยำ / อีสาน': 1, ของทานเล่น: 1, เครื่องดื่ม: 1, ของหวาน: 3 };

export function loadWoraMenu(): WoraMenu {
  return JSON.parse(readFileSync(path.join(DATA_DIR, 'menu.json'), 'utf8')) as WoraMenu;
}

/** Adds the WORA Grill menu to an organisation. Items whose SKU already exists are left untouched. */
export async function seedWoraMenu(db: DbOrTx, orgId: string, branchId: string, uploadDir: string): Promise<{ created: number; skipped: number }> {
  const data = loadWoraMenu();

  const haveStations = new Set((await db.select({ code: stations.code }).from(stations).where(eq(stations.branchId, branchId))).map((s) => s.code));
  const newStations = STATIONS.filter((s) => !haveStations.has(s.code));
  if (newStations.length) await db.insert(stations).values(newStations.map((s) => ({ organizationId: orgId, branchId, ...s })));

  const existingCats = await db.select().from(menuCategories).where(and(eq(menuCategories.organizationId, orgId), isNull(menuCategories.archivedAt)));
  const catId = new Map(existingCats.map((c) => [c.name, c.id]));
  let sort = existingCats.reduce((m, c) => Math.max(m, c.sort), 0);
  for (const c of data.categories) {
    if (catId.has(c.name)) continue;
    sort += 10;
    const [row] = await db
      .insert(menuCategories)
      .values({ organizationId: orgId, name: c.name, nameEn: c.nameEn, stationCode: CATEGORY_STATION[c.name] ?? 'HOT', sort })
      .returning();
    catId.set(c.name, row.id);
  }

  const existingSkus = new Set((await db.select({ sku: menuItems.sku }).from(menuItems).where(eq(menuItems.organizationId, orgId))).map((r) => r.sku));
  // Identical option groups (e.g. the spice level on 20 dishes) are shared, not duplicated.
  const groupIds = new Map<string, string>();
  const groupFor = async (g: WoraGroup) => {
    const key = JSON.stringify([g.name, g.min, g.max, g.options]);
    const hit = groupIds.get(key);
    if (hit) return hit;
    const [row] = await db
      .insert(modifierGroups)
      .values({ organizationId: orgId, name: g.name, nameEn: g.nameEn, minSelect: g.min, maxSelect: g.max, sort: groupIds.size + 1 })
      .returning();
    await db.insert(modifiers).values(
      g.options.map((o, i) => ({ groupId: row.id, name: o.name, nameEn: o.nameEn, priceDeltaSatang: o.priceDelta, isDefault: g.min > 0 && i === 0, sort: i + 1 })),
    );
    groupIds.set(key, row.id);
    return row.id;
  };

  let created = 0;
  let skipped = 0;
  for (const [index, it] of data.items.entries()) {
    if (existingSkus.has(it.sku)) {
      skipped++;
      continue;
    }
    const imageUrl = it.image ? await storeImage(uploadDir, 'menu', readFileSync(path.join(DATA_DIR, 'images', it.image))) : null;
    const [row] = await db
      .insert(menuItems)
      .values({
        organizationId: orgId,
        categoryId: catId.get(it.category)!,
        sku: it.sku,
        name: it.name,
        nameEn: it.nameEn,
        description: it.description,
        imageUrl,
        priceSatang: it.price,
        tags: it.tags,
        allergens: it.allergens,
        defaultCourse: CATEGORY_COURSE[it.category] ?? 2,
        sort: (index + 1) * 10,
      })
      .returning();
    const links: { menuItemId: string; groupId: string; sort: number }[] = [];
    for (const [s, g] of it.groups.entries()) links.push({ menuItemId: row.id, groupId: await groupFor(g), sort: s });
    if (links.length) await db.insert(menuItemModifierGroups).values(links);
    created++;
  }
  return { created, skipped };
}
