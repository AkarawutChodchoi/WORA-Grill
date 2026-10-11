import { date, index, integer, numeric, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common';
import { branches, organizations, users } from './core';
import { ingredients, warehouses } from './inventory';

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

export const suppliers = pgTable(
  'suppliers',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    phone: text('phone'),
    email: text('email'),
    lineId: text('line_id'),
    address: text('address'),
    taxId: text('tax_id'),
    /** Credit term in days (0 = cash on delivery). */
    paymentTermsDays: integer('payment_terms_days').notNull().default(0),
    note: text('note'),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('suppliers_org_name_uq').on(t.organizationId, t.name)],
);

/** What a supplier sells us, in which unit and at what price (for POs and price comparison). */
export const supplierItems = pgTable(
  'supplier_items',
  {
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    unit: text('unit').notNull(),
    priceSatang: integer('price_satang').notNull(),
    supplierSku: text('supplier_sku'),
    leadTimeDays: integer('lead_time_days').notNull().default(1),
    isPreferred: integer('is_preferred').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.supplierId, t.ingredientId] })],
);

export const PO_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED', 'REJECTED'] as const;

/**
 * Purchase request → purchase order. A document starts as DRAFT, is SUBMITTED as a purchase request,
 * becomes a PO when APPROVED, ORDERED when sent to the supplier, then PARTIAL/RECEIVED via goods receipts.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    poNo: text('po_no').notNull(),
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    status: text('status', { enum: PO_STATUSES }).notNull().default('DRAFT'),
    expectedDate: date('expected_date'),
    note: text('note'),
    totalSatang: integer('total_satang').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id),
    submittedAt: ts('submitted_at'),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: ts('approved_at'),
    rejectedReason: text('rejected_reason'),
    orderedAt: ts('ordered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('purchase_orders_no_uq').on(t.branchId, t.poNo), index('purchase_orders_branch_status_idx').on(t.branchId, t.status)],
);

export const poLines = pgTable(
  'po_lines',
  {
    id: pk(),
    poId: uuid('po_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    qty: qty('qty').notNull(),
    unit: text('unit').notNull(),
    qtyBase: qty('qty_base').notNull(),
    unitPriceSatang: integer('unit_price_satang').notNull(),
    lineTotalSatang: integer('line_total_satang').notNull(),
    receivedQtyBase: qty('received_qty_base').notNull().default('0'),
  },
  (t) => [index('po_lines_po_idx').on(t.poId)],
);

/** Goods receipt (GR). Posting is the only thing that adds purchased stock and updates cost. */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    grNo: text('gr_no').notNull(),
    poId: uuid('po_id').references(() => purchaseOrders.id),
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
    warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
    invoiceNo: text('invoice_no'),
    invoiceDate: date('invoice_date'),
    dueDate: date('due_date'),
    note: text('note'),
    totalSatang: integer('total_satang').notNull(),
    receivedBy: uuid('received_by').references(() => users.id),
    postedAt: ts('posted_at').notNull().defaultNow(),
  },
  (t) => [unique('goods_receipts_no_uq').on(t.branchId, t.grNo), index('goods_receipts_supplier_idx').on(t.supplierId)],
);

export const grLines = pgTable(
  'gr_lines',
  {
    id: pk(),
    grId: uuid('gr_id').notNull().references(() => goodsReceipts.id, { onDelete: 'cascade' }),
    poLineId: uuid('po_line_id').references(() => poLines.id),
    ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
    unit: text('unit').notNull(),
    /** Delivered quantity in `unit` (accepted + rejected). */
    deliveredQty: qty('delivered_qty').notNull(),
    acceptedQtyBase: qty('accepted_qty_base').notNull(),
    rejectedQtyBase: qty('rejected_qty_base').notNull().default('0'),
    rejectReason: text('reject_reason'),
    unitPriceSatang: integer('unit_price_satang').notNull(),
    lineTotalSatang: integer('line_total_satang').notNull(),
  },
  (t) => [index('gr_lines_gr_idx').on(t.grId)],
);

export const supplierReturns = pgTable('supplier_returns', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  returnNo: text('return_no').notNull(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  grId: uuid('gr_id').references(() => goodsReceipts.id),
  reason: text('reason').notNull(),
  /** Credit expected from the supplier, satang. */
  creditSatang: integer('credit_satang').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
});

export const supplierReturnLines = pgTable('supplier_return_lines', {
  id: pk(),
  returnId: uuid('return_id').notNull().references(() => supplierReturns.id, { onDelete: 'cascade' }),
  ingredientId: uuid('ingredient_id').notNull().references(() => ingredients.id),
  qty: qty('qty').notNull(),
  unit: text('unit').notNull(),
  qtyBase: qty('qty_base').notNull(),
  creditSatang: integer('credit_satang').notNull(),
});

/** Payments to suppliers against received goods (simple accounts payable). */
export const supplierPayments = pgTable(
  'supplier_payments',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
    grId: uuid('gr_id').references(() => goodsReceipts.id),
    amountSatang: integer('amount_satang').notNull(),
    method: text('method').notNull(),
    reference: text('reference'),
    paidAt: date('paid_at').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('supplier_payments_supplier_idx').on(t.supplierId)],
);
