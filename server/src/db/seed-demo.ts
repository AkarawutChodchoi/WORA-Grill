import type { DbOrTx } from './client';
import { eq } from 'drizzle-orm';
import { branches, diningTables, menuCategories, menuItemModifierGroups, menuItems, modifierGroups, modifiers, stations, zones } from './schema';

/**
 * Demo master data (menu, tables, ingredients…). Each module adds to this as it is built.
 * Everything here is labelled DEMO and only runs on an empty database.
 */
export async function seedDemoData(db: DbOrTx, orgId: string, branchId: string, _ownerId: string): Promise<void> {
  await db
    .update(branches)
    .set({ address: 'DEMO - 1 Example Road, Bangkok', phone: '02-000-0000', settings: { enabledPaymentMethods: ['CASH', 'CARD', 'TRANSFER'], receiptHeader: 'DEMO restaurant (test data)' } as never })
    .where(eq(branches.id, branchId));
  await seedMenu(db, orgId, branchId);
  await seedTables(db, orgId, branchId);
}

export async function seedTables(db: DbOrTx, orgId: string, branchId: string) {
  const [inside] = await db.insert(zones).values({ organizationId: orgId, branchId, name: 'ในร้าน', floor: '1', sort: 10 }).returning();
  const [terrace] = await db.insert(zones).values({ organizationId: orgId, branchId, name: 'ระเบียง', floor: '1', sort: 20 }).returning();
  const rows: (typeof diningTables.$inferInsert)[] = [];
  for (let i = 0; i < 8; i++)
    rows.push({ organizationId: orgId, branchId, zoneId: inside.id, name: `A${i + 1}`, capacity: i < 6 ? 4 : 6, posX: 1 + (i % 4) * 3, posY: 1 + Math.floor(i / 4) * 3, width: 2, height: 2 });
  for (let i = 0; i < 4; i++)
    rows.push({ organizationId: orgId, branchId, zoneId: terrace.id, name: `T${i + 1}`, capacity: 2, shape: 'round', posX: 1 + i * 3, posY: 1, width: 2, height: 2 });
  await db.insert(diningTables).values(rows);
}

async function seedMenu(db: DbOrTx, orgId: string, branchId: string) {
  await db.insert(stations).values([
    { organizationId: orgId, branchId, code: 'HOT', name: 'ครัวร้อน', sort: 10 },
    { organizationId: orgId, branchId, code: 'COLD', name: 'ครัวเย็น/ยำ', sort: 20 },
    { organizationId: orgId, branchId, code: 'BAR', name: 'บาร์น้ำ', sort: 30 },
    { organizationId: orgId, branchId, code: 'DESSERT', name: 'ของหวาน', sort: 40 },
    { organizationId: orgId, branchId, code: 'EXPO', name: 'Expo ตรวจก่อนเสิร์ฟ', sort: 50, isExpo: true },
  ]);
  const cat = async (name: string, nameEn: string, stationCode: string, sort: number) =>
    (await db.insert(menuCategories).values({ organizationId: orgId, name, nameEn, stationCode, sort }).returning())[0].id;
  const starters = await cat('ของทานเล่น', 'Starters', 'COLD', 10);
  const mains = await cat('อาหารจานเดียว', 'Single dishes', 'HOT', 20);
  const drinks = await cat('เครื่องดื่ม', 'Drinks', 'BAR', 30);
  const desserts = await cat('ของหวาน', 'Desserts', 'DESSERT', 40);

  const [spice] = await db.insert(modifierGroups).values({ organizationId: orgId, name: 'ระดับความเผ็ด', nameEn: 'Spice level', minSelect: 1, maxSelect: 1, sort: 10 }).returning();
  await db.insert(modifiers).values([
    { groupId: spice.id, name: 'ไม่เผ็ด', nameEn: 'Not spicy', sort: 1 },
    { groupId: spice.id, name: 'เผ็ดน้อย', nameEn: 'Mild', sort: 2, isDefault: true },
    { groupId: spice.id, name: 'เผ็ดมาก', nameEn: 'Hot', sort: 3 },
  ]);
  const [extra] = await db.insert(modifierGroups).values({ organizationId: orgId, name: 'เพิ่มพิเศษ', nameEn: 'Extras', minSelect: 0, maxSelect: 3, allowRepeat: true, sort: 20 }).returning();
  await db.insert(modifiers).values([
    { groupId: extra.id, name: 'ไข่ดาว', nameEn: 'Fried egg', priceDeltaSatang: 1000, sort: 1 },
    { groupId: extra.id, name: 'ไข่เจียว', nameEn: 'Omelette', priceDeltaSatang: 1500, sort: 2 },
    { groupId: extra.id, name: 'พิเศษ (เพิ่มเนื้อ)', nameEn: 'Extra meat', priceDeltaSatang: 2000, sort: 3 },
  ]);
  const [size] = await db.insert(modifierGroups).values({ organizationId: orgId, name: 'ขนาดแก้ว', nameEn: 'Cup size', minSelect: 1, maxSelect: 1, sort: 30 }).returning();
  await db.insert(modifiers).values([
    { groupId: size.id, name: 'ปกติ', nameEn: 'Regular', sort: 1, isDefault: true },
    { groupId: size.id, name: 'ใหญ่', nameEn: 'Large', priceDeltaSatang: 1000, sort: 2 },
  ]);
  const [sweet] = await db.insert(modifierGroups).values({ organizationId: orgId, name: 'ความหวาน', nameEn: 'Sweetness', minSelect: 0, maxSelect: 1, sort: 40 }).returning();
  await db.insert(modifiers).values([
    { groupId: sweet.id, name: 'หวานน้อย', nameEn: 'Less sweet', sort: 1 },
    { groupId: sweet.id, name: 'ไม่หวาน', nameEn: 'No sugar', sort: 2 },
  ]);

  type Seed = [string, string, string, number, string[], string[], string[], string?];
  const items: Seed[] = [
    [starters, 'ปอเปี๊ยะทอด', 'Fried spring rolls', 8900, ['vegetarian'], ['gluten'], [], 'P001'],
    [starters, 'ยำวุ้นเส้น', 'Glass noodle salad', 12000, ['spicy'], ['shellfish', 'fish'], [spice.id], 'P002'],
    [starters, 'ส้มตำไทย', 'Papaya salad', 7000, ['spicy', 'signature'], ['peanut', 'fish', 'shellfish'], [spice.id], 'P003'],
    [mains, 'ข้าวผัดกุ้ง', 'Shrimp fried rice', 9000, [], ['shellfish', 'egg'], [extra.id], 'M001'],
    [mains, 'ผัดกะเพราหมูสับ', 'Basil pork stir-fry', 7000, ['spicy', 'signature'], ['soy'], [spice.id, extra.id], 'M002'],
    [mains, 'ผัดไทยกุ้งสด', 'Pad Thai with shrimp', 11000, ['signature'], ['peanut', 'shellfish', 'egg'], [extra.id], 'M003'],
    [mains, 'ต้มยำกุ้งน้ำข้น', 'Tom yum goong', 18000, ['spicy'], ['shellfish', 'milk'], [spice.id], 'M004'],
    [mains, 'แกงเขียวหวานไก่', 'Green curry chicken', 12000, ['spicy'], ['milk'], [spice.id], 'M005'],
    [drinks, 'ชาไทยเย็น', 'Thai iced tea', 5500, [], ['milk'], [size.id, sweet.id], 'D001'],
    [drinks, 'กาแฟเย็น', 'Iced coffee', 6000, [], ['milk'], [size.id, sweet.id], 'D002'],
    [drinks, 'น้ำมะพร้าว', 'Coconut water', 6500, ['vegan'], [], [], 'D003'],
    [drinks, 'น้ำเปล่า', 'Water', 2000, ['vegan'], [], [], 'D004'],
    [desserts, 'ข้าวเหนียวมะม่วง', 'Mango sticky rice', 12000, ['signature', 'vegetarian'], ['milk'], [], 'S001'],
    [desserts, 'บัวลอยไข่หวาน', 'Bua loy with egg', 6500, [], ['egg', 'milk'], [], 'S002'],
  ];
  let sort = 0;
  for (const [categoryId, name, nameEn, price, tags, allergens, groups, sku] of items) {
    sort += 10;
    const [it] = await db
      .insert(menuItems)
      .values({ organizationId: orgId, categoryId, name, nameEn, priceSatang: price, tags, allergens, sku, sort, defaultCourse: categoryId === desserts ? 3 : categoryId === mains ? 2 : 1 })
      .returning();
    if (groups.length) await db.insert(menuItemModifierGroups).values(groups.map((groupId, s) => ({ menuItemId: it.id, groupId, sort: s })));
  }
}
