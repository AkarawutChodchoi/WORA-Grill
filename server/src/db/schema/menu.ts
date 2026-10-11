import { boolean, index, integer, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common';
import { branches, organizations, users } from './core';

/** Kitchen/bar stations per branch. Menu routes by station *code* so one central menu works in every branch. */
export const stations = pgTable(
  'stations',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
    /** Expo screen shows all stations. */
    isExpo: boolean('is_expo').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('stations_branch_code_uq').on(t.branchId, t.code)],
);

export const menuCategories = pgTable(
  'menu_categories',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    nameEn: text('name_en'),
    nameZh: text('name_zh'),
    sort: integer('sort').notNull().default(0),
    /** Default kitchen station code for items in this category. */
    stationCode: text('station_code'),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('menu_categories_org_idx').on(t.organizationId, t.sort)],
);

export const menuItems = pgTable(
  'menu_items',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    categoryId: uuid('category_id').notNull().references(() => menuCategories.id),
    sku: text('sku'),
    barcode: text('barcode'),
    name: text('name').notNull(),
    nameEn: text('name_en'),
    nameZh: text('name_zh'),
    description: text('description'),
    descriptionEn: text('description_en'),
    descriptionZh: text('description_zh'),
    imageUrl: text('image_url'),
    priceSatang: integer('price_satang').notNull(),
    /** Overrides the category station. */
    stationCode: text('station_code'),
    tags: text('tags').array().notNull().default([]),
    allergens: text('allergens').array().notNull().default([]),
    defaultCourse: integer('default_course').notNull().default(1),
    isCombo: boolean('is_combo').notNull().default(false),
    /** Bitmask Sun=1 … Sat=64; 127 = every day. */
    availableDays: integer('available_days').notNull().default(127),
    availableFrom: text('available_from'),
    availableTo: text('available_to'),
    /** Hidden from the customer QR menu (still sold at POS). */
    hideOnQr: boolean('hide_on_qr').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('menu_items_cat_idx').on(t.categoryId, t.sort), index('menu_items_org_idx').on(t.organizationId), unique('menu_items_org_sku_uq').on(t.organizationId, t.sku)],
);

/** Price overrides by branch and/or channel (null = any). Most specific wins. */
export const menuItemPrices = pgTable(
  'menu_item_prices',
  {
    id: pk(),
    menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id),
    channel: text('channel'),
    priceSatang: integer('price_satang').notNull(),
  },
  (t) => [unique('menu_item_prices_uq').on(t.menuItemId, t.branchId, t.channel).nullsNotDistinct()],
);

/** Per-branch availability: disabled in this branch, or sold out (86) right now. */
export const menuItemBranch = pgTable(
  'menu_item_branch',
  {
    menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    isEnabled: boolean('is_enabled').notNull().default(true),
    soldOut: boolean('sold_out').notNull().default(false),
    soldOutAt: ts('sold_out_at'),
    soldOutBy: uuid('sold_out_by').references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.menuItemId, t.branchId] })],
);

export const modifierGroups = pgTable('modifier_groups', {
  id: pk(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  nameEn: text('name_en'),
  nameZh: text('name_zh'),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  /** Whether the same option may be picked more than once (e.g. extra egg ×2). */
  allowRepeat: boolean('allow_repeat').notNull().default(false),
  sort: integer('sort').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
});

export const modifiers = pgTable(
  'modifiers',
  {
    id: pk(),
    groupId: uuid('group_id').notNull().references(() => modifierGroups.id),
    name: text('name').notNull(),
    nameEn: text('name_en'),
    nameZh: text('name_zh'),
    priceDeltaSatang: integer('price_delta_satang').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    archivedAt: ts('archived_at'),
  },
  (t) => [index('modifiers_group_idx').on(t.groupId)],
);

export const menuItemModifierGroups = pgTable(
  'menu_item_modifier_groups',
  {
    menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull().references(() => modifierGroups.id),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.menuItemId, t.groupId] })],
);

/** Fixed components of a combo/set item (shown to the kitchen). */
export const comboComponents = pgTable(
  'combo_components',
  {
    id: pk(),
    comboItemId: uuid('combo_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
    componentItemId: uuid('component_item_id').notNull().references(() => menuItems.id),
    qty: integer('qty').notNull().default(1),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [index('combo_components_combo_idx').on(t.comboItemId)],
);
