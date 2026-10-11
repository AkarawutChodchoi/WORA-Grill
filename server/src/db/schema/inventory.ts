import { sql } from 'drizzle-orm';
import { boolean, date, index, numeric, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common';
import { branches, organizations, users } from './core';
import { menuItems, modifiers } from './menu';

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });
const cost = (name: string) => numeric(name, { precision: 18, scale: 6 });

/** Raw materials and sub-recipes (e.g. soup stock). Quantities are stored in the base unit. */
export const ingredients = pgTable(
  'ingredients',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text('name').notNull(),
    sku: text('sku'),
    category: text('category'),
    /** Base (storage) unit, e.g. g, ml, pcs. */
    baseUnit: text('base_unit').notNull(),
    /** Alert when on-hand falls to or below this (base units). */
    reorderPoint: qty('reorder_point').notNull().default('0'),
    reorderQty: qty('reorder_qty').notNull().default('0'),
    isSubRecipe: boolean('is_sub_recipe').notNull().default(false),
    trackExpiry: boolean('track_expiry').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('ingredients_org_name_uq').on(t.organizationId, t.name)],
);

/** Explicit unit conversions per ingredient: 1 <unit> = factor × base unit (1 ลัง = 24 ขวด, 1 กก. = 1000 ก.). */
export const ingredientUnits = pgTable(
  'ingredient_units',
  {
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id, { onDelete: 'cascade' }),
    unit: text('unit').notNull(),
    factor: qty('factor').notNull(),
    isPurchase: boolean('is_purchase').notNull().default(false),
    isUsage: boolean('is_usage').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.ingredientId, t.unit] })],
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('warehouses_default_uq').on(t.branchId).where(sql`is_default`)],
);

/**
 * Cached on-hand quantity and weighted-average unit cost per warehouse. The ledger
 * (stock_movements) is the source of truth; /inventory/reconcile rebuilds this cache from it.
 */
export const stockBalances = pgTable(
  'stock_balances',
  {
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    qty: qty('qty').notNull().default('0'),
    /** Weighted-average cost in satang per base unit. */
    avgCost: cost('avg_cost').notNull().default('0'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.warehouseId, t.ingredientId] })],
);

export const STOCK_MOVEMENT_TYPES = [
  'PURCHASE',
  'SALE',
  'SALE_REVERSAL',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'WASTE',
  'ADJUST',
  'COUNT',
  'ISSUE',
  'PRODUCTION_IN',
  'PRODUCTION_OUT',
  'RETURN',
] as const;

/** Lots for expiry tracking (FEFO). Costing stays weighted-average (one method, not mixed). */
export const stockLots = pgTable(
  'stock_lots',
  {
    id: pk(),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    lotNo: text('lot_no'),
    expiryDate: date('expiry_date'),
    receivedQty: qty('received_qty').notNull(),
    remainingQty: qty('remaining_qty').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [index('stock_lots_fefo_idx').on(t.warehouseId, t.ingredientId, t.expiryDate)],
);

/** Append-only stock ledger. qty is signed, in base units. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    type: text('type', { enum: STOCK_MOVEMENT_TYPES }).notNull(),
    qty: qty('qty').notNull(),
    /** Satang per base unit used to value this movement. */
    unitCost: cost('unit_cost').notNull(),
    /** qty × unitCost, satang (signed). */
    value: numeric('value', { precision: 18, scale: 2 }).notNull(),
    /** On-hand after this movement (for audit/reconciliation). */
    balanceAfter: qty('balance_after').notNull(),
    lotId: uuid('lot_id').references(() => stockLots.id),
    refType: text('ref_type'),
    refId: text('ref_id'),
    reason: text('reason'),
    /** Prevents the same business event being posted twice (e.g. SALE:<orderItemId>:<ingredientId>). */
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('stock_movements_item_idx').on(t.warehouseId, t.ingredientId, t.createdAt),
    index('stock_movements_branch_created_idx').on(t.branchId, t.createdAt),
    index('stock_movements_ref_idx').on(t.refType, t.refId),
    uniqueIndex('stock_movements_idem_uq').on(t.idempotencyKey).where(sql`idempotency_key is not null`),
  ],
);

/** Recipe / BOM for a menu item, a modifier (e.g. extra egg) or a sub-recipe ingredient. */
export const recipes = pgTable(
  'recipes',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    menuItemId: uuid('menu_item_id').references(() => menuItems.id),
    modifierId: uuid('modifier_id').references(() => modifiers.id),
    /** For sub-recipes: the ingredient this recipe produces. */
    outputIngredientId: uuid('output_ingredient_id').references(() => ingredients.id),
    /** Base units produced by one batch (sub-recipes only). */
    yieldQty: qty('yield_qty').notNull().default('1'),
    note: text('note'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('recipes_menu_item_uq').on(t.menuItemId).where(sql`menu_item_id is not null`),
    uniqueIndex('recipes_modifier_uq').on(t.modifierId).where(sql`modifier_id is not null`),
    uniqueIndex('recipes_output_uq').on(t.outputIngredientId).where(sql`output_ingredient_id is not null`),
  ],
);

export const recipeLines = pgTable(
  'recipe_lines',
  {
    id: pk(),
    recipeId: uuid('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    /** Quantity as entered, in `unit`. */
    qty: qty('qty').notNull(),
    unit: text('unit').notNull(),
    /** Same quantity converted to base units (used for deduction). */
    qtyBase: qty('qty_base').notNull(),
  },
  (t) => [index('recipe_lines_recipe_idx').on(t.recipeId)],
);

export const stockCounts = pgTable('stock_counts', {
  id: pk(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  status: text('status', { enum: ['DRAFT', 'POSTED', 'CANCELLED'] }).notNull().default('DRAFT'),
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id),
  postedBy: uuid('posted_by').references(() => users.id),
  createdAt: createdAt(),
  postedAt: ts('posted_at'),
});

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    countId: uuid('count_id').notNull().references(() => stockCounts.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    /** System (theoretical) on-hand when the count was posted. */
    theoreticalQty: qty('theoretical_qty'),
    countedQty: qty('counted_qty'),
    varianceQty: qty('variance_qty'),
    unitCost: cost('unit_cost'),
  },
  (t) => [primaryKey({ columns: [t.countId, t.ingredientId] })],
);
