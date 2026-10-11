export interface OrderItem {
  id: string;
  orderId: string;
  menuItemId: string;
  nameSnapshot: string;
  nameEnSnapshot: string | null;
  basePriceSatang: number;
  unitPriceSatang: number;
  qty: number;
  modifiers: { modifierId: string; groupName: string; name: string; qty: number; priceDeltaSatang: number }[];
  comboComponents: { itemId: string; name: string; qty: number }[];
  allergens: string[];
  note: string | null;
  stationCode: string | null;
  course: number;
  held: boolean;
  awaitingApproval: boolean;
  source: string;
  status: 'PENDING' | 'SENT' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';
  discountSatang: number;
  lineTotalSatang: number;
  cancelledReason: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface OrderDiscount {
  id: string;
  scope: 'BILL' | 'ITEM';
  orderItemId: string | null;
  type: 'PERCENT' | 'AMOUNT';
  value: number;
  amountSatang: number;
  reason: string | null;
  couponCode: string | null;
  promotionId: string | null;
}

export interface Payment {
  id: string;
  method: string;
  status: 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'REFUNDED' | 'VOIDED';
  amountSatang: number;
  tenderedSatang: number | null;
  changeSatang: number;
  reference: string | null;
  refundedSatang: number;
  createdAt: string;
  confirmedAt: string | null;
}

export interface Order {
  id: string;
  orderNo: string;
  businessDate: string;
  channel: string;
  source: string;
  tableId: string | null;
  tableName: string | null;
  guestCount: number;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  status: 'OPEN' | 'BILL_REQUESTED' | 'PAID' | 'CLOSED' | 'VOIDED';
  subtotalSatang: number;
  discountSatang: number;
  serviceChargeSatang: number;
  vatSatang: number;
  grandTotalSatang: number;
  paidSatang: number;
  pricing: { vatMode: string; vatBps: number; serviceChargeBps: number; serviceChargeTaxable: boolean };
  note: string | null;
  splitFromOrderId: string | null;
  receiptNo: string | null;
  closedBy: string | null;
  mergedIntoOrderId: string | null;
  openedAt: string;
  openedByName: string | null;
  paidAt: string | null;
  closedAt: string | null;
  voidReason: string | null;
  version: number;
  items: OrderItem[];
  discounts: OrderDiscount[];
  payments?: Payment[];
  customer?: { id: string; name: string; phone: string | null; tier: string | null; pointsBalance: number; allergies?: string | null } | null;
}

/** A line tapped in the POS but not yet saved to the server. */
export interface DraftLine {
  id: string;
  menuItemId: string;
  name: string;
  unitPriceSatang: number;
  qty: number;
  modifiers: { modifierId: string; qty?: number; name: string; priceDeltaSatang: number }[];
  note?: string;
  course?: number;
  held?: boolean;
  /** Saved in the offline outbox, not yet confirmed by the server. */
  queued?: boolean;
}
