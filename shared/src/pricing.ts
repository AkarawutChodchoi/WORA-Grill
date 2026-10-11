import { applyBps, vatFromInclusive } from './money';

/** Tax/service configuration snapshotted on each order (from branch settings at open time). */
export interface PricingConfig {
  vatMode: 'EXCLUSIVE' | 'INCLUSIVE' | 'NONE' | string;
  vatBps: number;
  serviceChargeBps: number;
  serviceChargeTaxable: boolean;
}

export interface TotalsLine {
  unitPriceSatang: number;
  qty: number;
  discountSatang: number;
  status: string;
}

/** Bill-level discount: PERCENT value is basis points, AMOUNT value is satang. */
export interface BillDiscount {
  type: 'PERCENT' | 'AMOUNT';
  value: number;
}

export interface Totals {
  /** Sum of active lines before any discount. */
  subtotalSatang: number;
  itemDiscountSatang: number;
  billDiscountSatang: number;
  /** itemDiscount + billDiscount */
  discountSatang: number;
  /** After all discounts, before service charge. */
  netSatang: number;
  serviceChargeSatang: number;
  vatSatang: number;
  grandTotalSatang: number;
}

export function lineGross(l: Pick<TotalsLine, 'unitPriceSatang' | 'qty'>): number {
  return l.unitPriceSatang * l.qty;
}

/** Line total after its own discount (never negative). */
export function lineNet(l: Pick<TotalsLine, 'unitPriceSatang' | 'qty' | 'discountSatang'>): number {
  return Math.max(0, lineGross(l) - Math.max(0, l.discountSatang));
}

/**
 * Bill totals (SPEC §3.1): item discounts → bill discounts (in order) → service charge on the
 * discounted amount → VAT (exclusive: added; inclusive: extracted; none). Integer satang throughout.
 */
export function computeTotals(lines: TotalsLine[], billDiscounts: BillDiscount[], cfg: PricingConfig): Totals {
  const active = lines.filter((l) => l.status !== 'CANCELLED');
  const subtotal = active.reduce((a, l) => a + lineGross(l), 0);
  const afterItems = active.reduce((a, l) => a + lineNet(l), 0);
  const itemDiscount = subtotal - afterItems;

  let remaining = afterItems;
  for (const d of billDiscounts) {
    const amount = d.type === 'PERCENT' ? applyBps(remaining, Math.min(10_000, Math.max(0, d.value))) : Math.max(0, d.value);
    remaining -= Math.min(amount, remaining);
  }
  const billDiscount = afterItems - remaining;
  const net = remaining;
  const service = applyBps(net, cfg.serviceChargeBps);
  const taxable = net + (cfg.serviceChargeTaxable ? service : 0);

  let vat = 0;
  let grand = net + service;
  if (cfg.vatMode === 'EXCLUSIVE') {
    vat = applyBps(taxable, cfg.vatBps);
    grand += vat;
  } else if (cfg.vatMode === 'INCLUSIVE') {
    vat = vatFromInclusive(taxable, cfg.vatBps);
  }
  return {
    subtotalSatang: subtotal,
    itemDiscountSatang: itemDiscount,
    billDiscountSatang: billDiscount,
    discountSatang: itemDiscount + billDiscount,
    netSatang: net,
    serviceChargeSatang: service,
    vatSatang: vat,
    grandTotalSatang: grand,
  };
}
