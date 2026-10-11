export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  nameEn: string | null;
  nameZh: string | null;
  sort: number;
  stationCode: string | null;
  archivedAt: string | null;
}

export interface Modifier {
  id: string;
  name: string;
  nameEn: string | null;
  nameZh: string | null;
  priceDeltaSatang: number;
  isDefault: boolean;
  archivedAt: string | null;
}

export interface ModifierGroup {
  id: string;
  name: string;
  nameEn: string | null;
  nameZh: string | null;
  minSelect: number;
  maxSelect: number;
  allowRepeat: boolean;
  archivedAt: string | null;
  modifiers: Modifier[];
}

export interface AdminItem {
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
  availableDays: number;
  availableFrom: string | null;
  availableTo: string | null;
  archivedAt: string | null;
  modifierGroupIds: string[];
  prices: { branchId: string | null; channel: string | null; priceSatang: number }[];
  comboComponents: { componentItemId: string; qty: number }[];
  branchEnabled: boolean;
  soldOut: boolean;
}

export interface AdminMenu {
  categories: Category[];
  items: AdminItem[];
  modifierGroups: ModifierGroup[];
}

export interface Station {
  id: string;
  code: string;
  name: string;
  sort: number;
  isExpo: boolean;
}

/** Sellable branch menu as served by GET /menu (POS, waiter, QR). */
export interface MenuModifierGroup {
  id: string;
  name: string;
  nameEn?: string | null;
  nameZh?: string | null;
  minSelect: number;
  maxSelect: number;
  allowRepeat: boolean;
  modifiers: { id: string; name: string; nameEn?: string | null; nameZh?: string | null; priceDeltaSatang: number; isDefault?: boolean }[];
}
export interface MenuItem {
  id: string;
  categoryId: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  nameEn: string | null;
  nameZh: string | null;
  description: string | null;
  descriptionEn?: string | null;
  descriptionZh?: string | null;
  imageUrl: string | null;
  priceSatang: number;
  stationCode: string | null;
  tags: string[];
  allergens: string[];
  defaultCourse: number;
  isCombo: boolean;
  soldOut: boolean;
  available: boolean;
  unavailableReason: 'SOLD_OUT' | 'DISABLED' | 'SCHEDULE' | null;
  modifierGroups: MenuModifierGroup[];
  comboComponents: { itemId: string; name: string; qty: number }[];
}
export interface BranchMenu {
  categories: { id: string; parentId: string | null; name: string; nameEn: string | null; nameZh: string | null; sort: number }[];
  items: MenuItem[];
}
