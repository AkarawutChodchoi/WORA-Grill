import { z } from 'zod';

/** Branch-level settings (SPEC §3.17 ตั้งค่าร้าน). Missing keys fall back to defaults. */
export const branchSettingsSchema = z.object({
  vatMode: z.enum(['EXCLUSIVE', 'INCLUSIVE', 'NONE']).default('EXCLUSIVE'),
  vatBps: z.number().int().min(0).max(3000).default(700),
  serviceChargeBps: z.number().int().min(0).max(3000).default(1000),
  /** Channels the service charge applies to. */
  serviceChargeChannels: z.array(z.string()).default(['DINE_IN']),
  /** Whether VAT is charged on the service charge (Thai practice: yes). */
  serviceChargeTaxable: z.boolean().default(true),
  /** Max bill/item discount a user with bill.discount (but not bill.discount_override) may give. */
  maxDiscountBps: z.number().int().min(0).max(10000).default(2000),
  receiptHeader: z.string().max(500).default(''),
  receiptFooter: z.string().max(500).default('ขอบคุณที่ใช้บริการ'),
  /** KDS aging thresholds in minutes. */
  kdsWarnMinutes: z.number().int().min(1).max(240).default(10),
  kdsLateMinutes: z.number().int().min(1).max(480).default(20),
  /** QR self-ordering. */
  qrOrderingEnabled: z.boolean().default(true),
  qrRequireApproval: z.boolean().default(false),
  qrTokenTtlMinutes: z.number().int().min(15).max(24 * 60).default(240),
  /** PromptPay target (phone or tax id) for static QR generation; empty = PromptPay disabled. */
  promptPayId: z.string().max(20).default(''),
  /** Payment methods the branch accepts. Only listed methods are offered in the POS. */
  enabledPaymentMethods: z.array(z.enum(['CASH', 'PROMPTPAY', 'CARD', 'EWALLET', 'TRANSFER', 'VOUCHER'])).default(['CASH']),
  /** Reservation defaults. */
  reservationSeatingMinutes: z.number().int().min(15).max(600).default(90),
  openTime: z.string().regex(/^\d{2}:\d{2}$/).default('10:00'),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
});
export type BranchSettings = z.infer<typeof branchSettingsSchema>;

export const orgSettingsSchema = z.object({
  currency: z.literal('THB').default('THB'),
  loyalty: z
    .object({
      enabled: z.boolean().default(false),
      /** Points earned per 1 THB of net paid amount, expressed per 100 THB to stay integral. */
      pointsPer100Baht: z.number().int().min(0).max(1000).default(1),
      /** Redemption value of one point in satang. */
      pointValueSatang: z.number().int().min(0).max(10000).default(100),
      /** Points expire after N months; 0 = never. */
      expiryMonths: z.number().int().min(0).max(120).default(0),
      tiers: z
        .array(z.object({ code: z.string(), name: z.string(), minSpendSatang: z.number().int().min(0), earnMultiplierBps: z.number().int().min(10000).max(50000) }))
        .default([]),
      birthdayCouponPromotionId: z.string().uuid().nullable().default(null),
    })
    .default({ enabled: false, pointsPer100Baht: 1, pointValueSatang: 100, expiryMonths: 0, tiers: [], birthdayCouponPromotionId: null }),
  /** Data retention for customer PII after last visit (PDPA), months; 0 = keep until deletion request. */
  customerRetentionMonths: z.number().int().min(0).max(240).default(0),
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export function resolveBranchSettings(raw: unknown): BranchSettings {
  return branchSettingsSchema.parse(raw ?? {});
}
export function resolveOrgSettings(raw: unknown): OrgSettings {
  return orgSettingsSchema.parse(raw ?? {});
}
