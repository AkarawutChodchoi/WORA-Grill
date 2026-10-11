import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SALES_CHANNELS } from '@shared/states';
import { nonEmpty, satang, uuid } from '@shared/validation';
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
  stations,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAnyPerm, requireBranch, requirePerm, type AuthContext } from '../../lib/auth';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../../lib/errors';
import { storeImage } from '../../lib/uploads';
import { seedWoraMenu } from '../../db/seed-wora';
import { loadBranchMenu } from './service';

const optText = (max = 500) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'รูปแบบเวลา HH:MM');
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/, 'รหัสใช้ A-Z 0-9 _ -');

const categoryBody = z.object({
  name: nonEmpty(100),
  nameEn: optText(100),
  nameZh: optText(100),
  parentId: uuid.nullable().optional(),
  stationCode: code.nullable().optional(),
});

const itemBody = z.object({
  categoryId: uuid,
  name: nonEmpty(120),
  nameEn: optText(120),
  nameZh: optText(120),
  description: optText(),
  descriptionEn: optText(),
  descriptionZh: optText(),
  sku: optText(40),
  barcode: optText(40),
  priceSatang: satang,
  stationCode: code.nullable().optional(),
  tags: z.array(z.string().max(30)).max(10).default([]),
  allergens: z.array(z.string().max(30)).max(15).default([]),
  defaultCourse: z.number().int().min(1).max(5).default(1),
  isCombo: z.boolean().default(false),
  hideOnQr: z.boolean().default(false),
  availableDays: z.number().int().min(1).max(127).default(127),
  availableFrom: hhmm.nullable().optional(),
  availableTo: hhmm.nullable().optional(),
  modifierGroupIds: z.array(uuid).max(20).default([]),
  prices: z.array(z.object({ branchId: uuid.nullable(), channel: z.enum(SALES_CHANNELS).nullable(), priceSatang: satang })).max(50).default([]),
  comboComponents: z.array(z.object({ componentItemId: uuid, qty: z.number().int().min(1).max(20) })).max(20).default([]),
});

const groupBody = z
  .object({
    name: nonEmpty(100),
    nameEn: optText(100),
    nameZh: optText(100),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(0).max(20),
    allowRepeat: z.boolean().default(false),
    modifiers: z
      .array(
        z.object({
          id: uuid.optional(),
          name: nonEmpty(100),
          nameEn: optText(100),
          nameZh: optText(100),
          priceDeltaSatang: z.number().int().min(-100_000_00).max(100_000_00),
          isDefault: z.boolean().default(false),
        }),
      )
      .min(1, 'ต้องมีตัวเลือกอย่างน้อย 1 รายการ')
      .max(50),
  })
  .refine((g) => g.maxSelect === 0 || g.maxSelect >= g.minSelect, { message: 'จำนวนสูงสุดต้องไม่น้อยกว่าขั้นต่ำ', path: ['maxSelect'] })
  .refine((g) => g.allowRepeat || g.minSelect <= g.modifiers.length, { message: 'ขั้นต่ำมากกว่าจำนวนตัวเลือก', path: ['minSelect'] });

async function ownCategory(db: DbOrTx, orgId: string, id: string) {
  const [c] = await db.select().from(menuCategories).where(and(eq(menuCategories.id, id), eq(menuCategories.organizationId, orgId)));
  if (!c) throw notFound('หมวดหมู่');
  return c;
}
async function ownItem(db: DbOrTx, orgId: string, id: string) {
  const [i] = await db.select().from(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.organizationId, orgId)));
  if (!i) throw notFound('เมนู');
  return i;
}

/** Validate every foreign id in an item payload belongs to the caller's organisation. */
async function checkItemRefs(db: DbOrTx, a: AuthContext, body: z.infer<typeof itemBody>, selfId?: string) {
  await ownCategory(db, a.orgId, body.categoryId);
  if (body.modifierGroupIds.length) {
    const g = await db.select({ id: modifierGroups.id }).from(modifierGroups).where(and(inArray(modifierGroups.id, body.modifierGroupIds), eq(modifierGroups.organizationId, a.orgId)));
    if (g.length !== new Set(body.modifierGroupIds).size) throw badRequest('กลุ่มตัวเลือกไม่ถูกต้อง');
  }
  const branchIds = [...new Set(body.prices.map((p) => p.branchId).filter((x): x is string => !!x))];
  if (branchIds.length) {
    const b = await db.select({ id: branches.id }).from(branches).where(and(inArray(branches.id, branchIds), eq(branches.organizationId, a.orgId)));
    if (b.length !== branchIds.length) throw badRequest('สาขาในราคาพิเศษไม่ถูกต้อง');
  }
  const keys = body.prices.map((p) => `${p.branchId}|${p.channel}`);
  if (new Set(keys).size !== keys.length) throw badRequest('มีราคาพิเศษซ้ำกันสำหรับสาขา/ช่องทางเดียวกัน');
  if (body.comboComponents.length) {
    if (!body.isCombo) throw badRequest('เมนูที่มีส่วนประกอบต้องตั้งเป็นเมนูชุด');
    const ids = body.comboComponents.map((c) => c.componentItemId);
    if (selfId && ids.includes(selfId)) throw badRequest('เมนูชุดมีตัวเองเป็นส่วนประกอบไม่ได้');
    const found = await db.select({ id: menuItems.id }).from(menuItems).where(and(inArray(menuItems.id, ids), eq(menuItems.organizationId, a.orgId)));
    if (found.length !== new Set(ids).size) throw badRequest('ส่วนประกอบเมนูชุดไม่ถูกต้อง');
  }
  if ((body.availableFrom == null) !== (body.availableTo == null)) throw badRequest('ต้องกำหนดเวลาเริ่มและเวลาสิ้นสุดคู่กัน');
}

async function writeItemChildren(tx: DbOrTx, itemId: string, body: z.infer<typeof itemBody>) {
  await tx.delete(menuItemModifierGroups).where(eq(menuItemModifierGroups.menuItemId, itemId));
  if (body.modifierGroupIds.length) await tx.insert(menuItemModifierGroups).values(body.modifierGroupIds.map((groupId, sort) => ({ menuItemId: itemId, groupId, sort })));
  await tx.delete(menuItemPrices).where(eq(menuItemPrices.menuItemId, itemId));
  if (body.prices.length) await tx.insert(menuItemPrices).values(body.prices.map((p) => ({ menuItemId: itemId, ...p })));
  await tx.delete(comboComponents).where(eq(comboComponents.comboItemId, itemId));
  if (body.comboComponents.length) await tx.insert(comboComponents).values(body.comboComponents.map((c, sort) => ({ comboItemId: itemId, ...c, sort })));
}

function itemColumns(body: z.infer<typeof itemBody>) {
  const { modifierGroupIds: _m, prices: _p, comboComponents: _c, ...cols } = body;
  return { ...cols, availableFrom: cols.availableFrom ?? null, availableTo: cols.availableTo ?? null, stationCode: cols.stationCode ?? null };
}

export default async function menuRoutes(app: FastifyInstance) {
  const { db, bus, config } = app.deps;
  const notifyMenu = (a: AuthContext, payload: Record<string, unknown> = {}) => bus.publish({ type: 'menu.updated', organizationId: a.orgId, branchId: null, payload });

  /** Sellable menu for the current branch (POS / waiter). */
  app.get('/menu', async (req) => {
    const a = requireAnyPerm(req, 'menu.view', 'order.create');
    const { channel } = parse(z.object({ channel: z.enum(SALES_CHANNELS).default('DINE_IN') }), req.query);
    return loadBranchMenu(db, { orgId: a.orgId, branchId: requireBranch(a), channel });
  });

  /** Full editable menu for back office, including archived records and per-branch state. */
  app.get('/menu/admin', async (req) => {
    const a = requirePerm(req, 'menu.view');
    const branchId = a.branchId;
    const [cats, items, groups] = await Promise.all([
      db.select().from(menuCategories).where(eq(menuCategories.organizationId, a.orgId)).orderBy(asc(menuCategories.sort), asc(menuCategories.name)),
      db.select().from(menuItems).where(eq(menuItems.organizationId, a.orgId)).orderBy(asc(menuItems.sort), asc(menuItems.name)),
      db.select().from(modifierGroups).where(eq(modifierGroups.organizationId, a.orgId)).orderBy(asc(modifierGroups.sort), asc(modifierGroups.name)),
    ]);
    const itemIds = items.map((i) => i.id);
    const groupIds = groups.map((g) => g.id);
    const [mods, links, prices, combos, states] = await Promise.all([
      groupIds.length ? db.select().from(modifiers).where(inArray(modifiers.groupId, groupIds)).orderBy(asc(modifiers.sort)) : [],
      itemIds.length ? db.select().from(menuItemModifierGroups).where(inArray(menuItemModifierGroups.menuItemId, itemIds)).orderBy(asc(menuItemModifierGroups.sort)) : [],
      itemIds.length ? db.select().from(menuItemPrices).where(inArray(menuItemPrices.menuItemId, itemIds)) : [],
      itemIds.length ? db.select().from(comboComponents).where(inArray(comboComponents.comboItemId, itemIds)).orderBy(asc(comboComponents.sort)) : [],
      itemIds.length && branchId ? db.select().from(menuItemBranch).where(and(inArray(menuItemBranch.menuItemId, itemIds), eq(menuItemBranch.branchId, branchId))) : [],
    ]);
    return {
      categories: cats,
      items: items.map((i) => {
        const st = states.find((s) => s.menuItemId === i.id);
        return {
          ...i,
          modifierGroupIds: links.filter((l) => l.menuItemId === i.id).map((l) => l.groupId),
          prices: prices.filter((p) => p.menuItemId === i.id).map(({ branchId: b, channel, priceSatang }) => ({ branchId: b, channel, priceSatang })),
          comboComponents: combos.filter((c) => c.comboItemId === i.id).map(({ componentItemId, qty }) => ({ componentItemId, qty })),
          branchEnabled: st ? st.isEnabled : true,
          soldOut: st?.soldOut ?? false,
        };
      }),
      modifierGroups: groups.map((g) => ({ ...g, modifiers: mods.filter((m) => m.groupId === g.id) })),
    };
  });

  // ---- Categories ----
  app.post('/menu/categories', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const body = parse(categoryBody, req.body);
    if (body.parentId) await ownCategory(db, a.orgId, body.parentId);
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${menuCategories.sort}), 0)::int` }).from(menuCategories).where(eq(menuCategories.organizationId, a.orgId));
    const [c] = await db.insert(menuCategories).values({ organizationId: a.orgId, ...body, sort: max + 10 }).returning();
    await audit(db, a, { action: 'menu.category.create', targetType: 'menu_category', targetId: c.id, data: body, branchId: null }, req.ip);
    notifyMenu(a);
    return c;
  });

  app.patch('/menu/categories/:id', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(categoryBody.partial().extend({ archived: z.boolean().optional() }), req.body);
    const before = await ownCategory(db, a.orgId, id);
    if (body.parentId) {
      if (body.parentId === id) throw badRequest('หมวดหมู่เป็นหมวดแม่ของตัวเองไม่ได้');
      await ownCategory(db, a.orgId, body.parentId);
    }
    const { archived, ...cols } = body;
    const [c] = await db
      .update(menuCategories)
      .set({ ...cols, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
      .where(eq(menuCategories.id, id))
      .returning();
    await audit(db, a, { action: archived ? 'menu.category.archive' : 'menu.category.update', targetType: 'menu_category', targetId: id, data: { before: { name: before.name }, after: body }, branchId: null }, req.ip);
    notifyMenu(a);
    return c;
  });

  app.put('/menu/categories/order', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(500) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(menuCategories).set({ sort: (i + 1) * 10 }).where(and(eq(menuCategories.id, id), eq(menuCategories.organizationId, a.orgId)));
    });
    notifyMenu(a);
    return { ok: true };
  });

  // ---- Items ----
  /** Adds the WORA Grill sample menu (50 dishes + photos). Dishes whose SKU already exists are skipped. */
  app.post('/menu/import-sample', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const branchId = requireBranch(a);
    const r = await db.transaction(async (tx) => {
      const res = await seedWoraMenu(tx, a.orgId, branchId, config.UPLOAD_DIR);
      await audit(tx, a, { action: 'menu.import_sample', targetType: 'menu', data: res, branchId: null }, req.ip);
      return res;
    });
    return r;
  });

  app.post('/menu/items', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const body = parse(itemBody, req.body);
    await checkItemRefs(db, a, body);
    try {
      const item = await db.transaction(async (tx) => {
        const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${menuItems.sort}), 0)::int` }).from(menuItems).where(eq(menuItems.categoryId, body.categoryId));
        const [i] = await tx.insert(menuItems).values({ organizationId: a.orgId, ...itemColumns(body), sort: max + 10 }).returning();
        await writeItemChildren(tx, i.id, body);
        await audit(tx, a, { action: 'menu.item.create', targetType: 'menu_item', targetId: i.id, data: { name: body.name, priceSatang: body.priceSatang }, branchId: null }, req.ip);
        return i;
      });
      notifyMenu(a);
      return item;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('รหัส SKU นี้ถูกใช้แล้ว');
      throw e;
    }
  });

  app.put('/menu/items/:id', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(itemBody, req.body);
    const before = await ownItem(db, a.orgId, id);
    await checkItemRefs(db, a, body, id);
    try {
      const item = await db.transaction(async (tx) => {
        const [i] = await tx.update(menuItems).set(itemColumns(body)).where(eq(menuItems.id, id)).returning();
        await writeItemChildren(tx, id, body);
        await audit(
          tx,
          a,
          {
            action: 'menu.item.update',
            targetType: 'menu_item',
            targetId: id,
            data: { name: body.name, priceBefore: before.priceSatang, priceAfter: body.priceSatang, prices: body.prices },
            branchId: null,
          },
          req.ip,
        );
        return i;
      });
      notifyMenu(a);
      return item;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('รหัส SKU นี้ถูกใช้แล้ว');
      throw e;
    }
  });

  app.post('/menu/items/:id/archive', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    await ownItem(db, a.orgId, id);
    await db.update(menuItems).set({ archivedAt: archived ? new Date() : null }).where(eq(menuItems.id, id));
    await audit(db, a, { action: archived ? 'menu.item.archive' : 'menu.item.restore', targetType: 'menu_item', targetId: id, branchId: null }, req.ip);
    notifyMenu(a);
    return { ok: true };
  });

  app.put('/menu/items/order', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(1000) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(menuItems).set({ sort: (i + 1) * 10 }).where(and(eq(menuItems.id, id), eq(menuItems.organizationId, a.orgId)));
    });
    notifyMenu(a);
    return { ok: true };
  });

  app.post('/menu/items/:id/image', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ownItem(db, a.orgId, id);
    const file = await req.file();
    if (!file) throw badRequest('ไม่พบไฟล์');
    const buf = await file.toBuffer();
    const url = await storeImage(config.UPLOAD_DIR, 'menu', buf);
    await db.update(menuItems).set({ imageUrl: url }).where(eq(menuItems.id, id));
    await audit(db, a, { action: 'menu.item.image', targetType: 'menu_item', targetId: id, data: { url }, branchId: null }, req.ip);
    notifyMenu(a);
    return { imageUrl: url };
  });

  /** Enable/disable an item in the current branch (central menu + branch override, SPEC §3.16). */
  app.put('/menu/items/:id/branch', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { isEnabled } = parse(z.object({ isEnabled: z.boolean() }), req.body);
    await ownItem(db, a.orgId, id);
    await db
      .insert(menuItemBranch)
      .values({ menuItemId: id, branchId, isEnabled })
      .onConflictDoUpdate({ target: [menuItemBranch.menuItemId, menuItemBranch.branchId], set: { isEnabled } });
    await audit(db, a, { action: 'menu.item.branch_enabled', targetType: 'menu_item', targetId: id, data: { isEnabled } }, req.ip);
    bus.publish({ type: 'menu.updated', organizationId: a.orgId, branchId, payload: { menuItemId: id } });
    return { ok: true };
  });

  /** 86 an item: immediately unavailable in POS and QR for this branch (SPEC §3.6). */
  app.post('/menu/items/:id/sold-out', async (req) => {
    const a = requirePerm(req, 'menu.sold_out');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { soldOut } = parse(z.object({ soldOut: z.boolean() }), req.body);
    const item = await ownItem(db, a.orgId, id);
    const now = new Date();
    await db
      .insert(menuItemBranch)
      .values({ menuItemId: id, branchId, soldOut, soldOutAt: soldOut ? now : null, soldOutBy: soldOut ? a.userId : null })
      .onConflictDoUpdate({
        target: [menuItemBranch.menuItemId, menuItemBranch.branchId],
        set: { soldOut, soldOutAt: soldOut ? now : null, soldOutBy: soldOut ? a.userId : null },
      });
    await audit(db, a, { action: soldOut ? 'menu.sold_out' : 'menu.back_in_stock', targetType: 'menu_item', targetId: id, data: { name: item.name } }, req.ip);
    bus.publish({ type: 'menu.sold_out', organizationId: a.orgId, branchId, payload: { menuItemId: id, soldOut, name: item.name } });
    return { ok: true };
  });

  // ---- Modifier groups ----
  app.post('/menu/modifier-groups', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const body = parse(groupBody, req.body);
    const g = await db.transaction(async (tx) => {
      const { modifiers: list, ...cols } = body;
      const [g] = await tx.insert(modifierGroups).values({ organizationId: a.orgId, ...cols }).returning();
      await tx.insert(modifiers).values(list.map(({ id: _id, ...m }, sort) => ({ groupId: g.id, ...m, sort })));
      await audit(tx, a, { action: 'menu.modifier_group.create', targetType: 'modifier_group', targetId: g.id, data: body, branchId: null }, req.ip);
      return g;
    });
    notifyMenu(a);
    return g;
  });

  app.put('/menu/modifier-groups/:id', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(groupBody, req.body);
    const [g] = await db.select().from(modifierGroups).where(and(eq(modifierGroups.id, id), eq(modifierGroups.organizationId, a.orgId)));
    if (!g) throw notFound('กลุ่มตัวเลือก');
    await db.transaction(async (tx) => {
      const { modifiers: list, ...cols } = body;
      await tx.update(modifierGroups).set(cols).where(eq(modifierGroups.id, id));
      const existing = await tx.select().from(modifiers).where(eq(modifiers.groupId, id));
      const keep = new Set(list.map((m) => m.id).filter(Boolean));
      // Modifiers referenced by historical orders are archived, never deleted.
      for (const e of existing) if (!keep.has(e.id) && !e.archivedAt) await tx.update(modifiers).set({ archivedAt: new Date() }).where(eq(modifiers.id, e.id));
      for (const [sort, m] of list.entries()) {
        const { id: mid, ...cols2 } = m;
        if (mid && existing.some((e) => e.id === mid)) await tx.update(modifiers).set({ ...cols2, sort, archivedAt: null }).where(eq(modifiers.id, mid));
        else await tx.insert(modifiers).values({ groupId: id, ...cols2, sort });
      }
      await audit(tx, a, { action: 'menu.modifier_group.update', targetType: 'modifier_group', targetId: id, data: body, branchId: null }, req.ip);
    });
    notifyMenu(a);
    return { ok: true };
  });

  app.post('/menu/modifier-groups/:id/archive', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    const r = await db
      .update(modifierGroups)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(modifierGroups.id, id), eq(modifierGroups.organizationId, a.orgId)))
      .returning({ id: modifierGroups.id });
    if (!r.length) throw notFound('กลุ่มตัวเลือก');
    await audit(db, a, { action: 'menu.modifier_group.archive', targetType: 'modifier_group', targetId: id, data: { archived }, branchId: null }, req.ip);
    notifyMenu(a);
    return { ok: true };
  });

  // ---- Stations (per branch) ----
  app.get('/stations', async (req) => {
    const a = requireAnyPerm(req, 'menu.view', 'kitchen.view');
    const branchId = requireBranch(a);
    return { stations: await db.select().from(stations).where(and(eq(stations.branchId, branchId), isNull(stations.archivedAt))).orderBy(asc(stations.sort)) };
  });

  const stationBody = z.object({ code, name: nonEmpty(60), isExpo: z.boolean().default(false), sort: z.number().int().min(0).max(1000).default(0) });

  app.post('/stations', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const branchId = requireBranch(a);
    const body = parse(stationBody, req.body);
    try {
      const [s] = await db.insert(stations).values({ organizationId: a.orgId, branchId, ...body }).returning();
      await audit(db, a, { action: 'station.create', targetType: 'station', targetId: s.id, data: body }, req.ip);
      return s;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('รหัสสเตชันนี้มีอยู่แล้วในสาขา');
      throw e;
    }
  });

  app.patch('/stations/:id', async (req) => {
    const a = requirePerm(req, 'menu.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(stationBody.partial().extend({ archived: z.boolean().optional() }), req.body);
    const { archived, ...cols } = body;
    const [s] = await db
      .update(stations)
      .set({ ...cols, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
      .where(and(eq(stations.id, id), eq(stations.branchId, branchId)))
      .returning();
    if (!s) throw notFound('สเตชัน');
    await audit(db, a, { action: 'station.update', targetType: 'station', targetId: id, data: body }, req.ip);
    return s;
  });
}
