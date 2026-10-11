/** Order and order-item state machines (SPEC §4.2). */
export const ORDER_STATUSES = ['OPEN', 'BILL_REQUESTED', 'PAID', 'CLOSED', 'VOIDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  OPEN: ['BILL_REQUESTED', 'PAID', 'VOIDED'],
  BILL_REQUESTED: ['OPEN', 'PAID', 'VOIDED'],
  PAID: ['CLOSED', 'OPEN'], // PAID -> OPEN only via full refund/reopen with permission
  CLOSED: [],
  VOIDED: [],
};

export const ITEM_STATUSES = ['PENDING', 'SENT', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  PENDING: ['SENT', 'CANCELLED'],
  SENT: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'SENT', 'CANCELLED'],
  READY: ['SERVED', 'PREPARING', 'CANCELLED'],
  SERVED: [],
  CANCELLED: [],
};

export function canTransition<S extends string>(map: Record<S, readonly S[]>, from: S, to: S): boolean {
  return map[from]?.includes(to) ?? false;
}

export const TABLE_STATUSES = ['AVAILABLE', 'OCCUPIED', 'WAITING_FOOD', 'DINING', 'BILL_REQUESTED', 'CLEANING'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const SALES_CHANNELS = ['DINE_IN', 'TAKEAWAY', 'DELIVERY', 'GRAB', 'LINEMAN', 'SHOPEEFOOD', 'QR'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];
/** Channels that order through our own POS/QR flow (others arrive via delivery integrations). */
export const POS_CHANNELS: readonly SalesChannel[] = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'];
