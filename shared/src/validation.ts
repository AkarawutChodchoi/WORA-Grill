import { z } from 'zod';

export const uuid = z.string().uuid();
export const pinSchema = z.string().regex(/^\d{4,6}$/, 'PIN ต้องเป็นตัวเลข 4–6 หลัก');
export const passwordSchema = z.string().min(10, 'รหัสผ่านอย่างน้อย 10 ตัวอักษร').max(200);
export const emailSchema = z.string().trim().toLowerCase().email('อีเมลไม่ถูกต้อง').max(200);
/** Integer satang, non-negative, below 100 million baht. */
export const satang = z.number().int().min(0).max(10_000_000_000);
export const nonEmpty = (max = 200) => z.string().trim().min(1, 'ต้องระบุ').max(max);
export const reasonSchema = z.string().trim().min(3, 'กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร').max(500);
export const approvalSchema = z.object({ userId: uuid, pin: pinSchema }).nullable().optional();
/** Decimal quantity as string or number, e.g. "1.5". Up to 4 decimals. */
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d{1,4})?$/.test(v), 'ตัวเลขไม่ถูกต้อง');
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ YYYY-MM-DD');
