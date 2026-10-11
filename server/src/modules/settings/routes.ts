import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { branchSettingsSchema, resolveBranchSettings } from '@shared/settings';
import { branches } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAuth, requireBranch, requirePerm } from '../../lib/auth';
import { badRequest, parse } from '../../lib/errors';

export default async function settingsRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  /** Branch profile + effective settings (read by POS for payment methods, VAT display, KDS timers…). */
  app.get('/settings/branch', async (req) => {
    const a = requireAuth(req);
    const branchId = requireBranch(a);
    const [b] = await db.select().from(branches).where(eq(branches.id, branchId));
    return { branch: { id: b.id, code: b.code, name: b.name, address: b.address, phone: b.phone, taxId: b.taxId, timezone: b.timezone }, settings: resolveBranchSettings(b.settings) };
  });

  app.put('/settings/branch', async (req) => {
    const a = requirePerm(req, 'settings.manage');
    const branchId = requireBranch(a);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        address: z.string().trim().max(500).nullable(),
        phone: z.string().trim().max(30).nullable(),
        taxId: z
          .string()
          .regex(/^\d{13}$/, 'เลขประจำตัวผู้เสียภาษี 13 หลัก')
          .nullable(),
        timezone: z.string().max(60),
        settings: branchSettingsSchema,
      }),
      req.body,
    );
    try {
      new Intl.DateTimeFormat('en', { timeZone: body.timezone });
    } catch {
      throw badRequest('Timezone ไม่ถูกต้อง');
    }
    if (body.settings.kdsLateMinutes <= body.settings.kdsWarnMinutes) throw badRequest('เวลาเตือนสีแดงต้องมากกว่าสีเหลือง');
    if (body.settings.enabledPaymentMethods.includes('PROMPTPAY') && !body.settings.promptPayId) throw badRequest('เปิดรับ PromptPay ต้องระบุ PromptPay ID');
    const [before] = await db.select().from(branches).where(eq(branches.id, branchId));
    await db.update(branches).set(body).where(eq(branches.id, branchId));
    await audit(db, a, { action: 'settings.branch_update', targetType: 'branch', targetId: branchId, data: { before: { ...before.settings, taxId: before.taxId }, after: { ...body.settings, taxId: body.taxId } } }, req.ip);
    return { ok: true };
  });
}
