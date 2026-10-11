import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateString, nonEmpty, reasonSchema, satang, uuid } from '@shared/validation';
import type { DbOrTx } from '../../db/client';
import { attendance, branches, roles, staffProfiles, staffShifts, userRoles, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireAnyPerm, requireAuth, requireBranch, requirePerm, resolvePermissions } from '../../lib/auth';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, parse } from '../../lib/errors';
import { localRange } from '../../lib/time';
import { branchSettings } from '../menu/service';
import { laborCostProvider, type Range } from '../reports/service';

const iso = z.string().datetime({ offset: true });

/** Users who hold any role in the branch (or org-wide). */
async function branchStaffIds(db: DbOrTx, branchId: string) {
  const rows = await db
    .selectDistinct({ id: userRoles.userId })
    .from(userRoles)
    .where(or(eq(userRoles.branchId, branchId), isNull(userRoles.branchId)));
  return rows.map((r) => r.id);
}

/** Labor cost from attendance × wage (hourly: hours worked, daily: days worked, monthly: pro-rata). */
export async function computeLaborCost(db: DbOrTx, r: Range) {
  const tz = (await db.select({ tz: branches.timezone }).from(branches).where(eq(branches.id, r.branchIds[0])))[0]?.tz ?? 'Asia/Bangkok';
  const [from, to] = localRange(r.from, r.to, tz);
  const recs = await db
    .select({ a: attendance, p: staffProfiles })
    .from(attendance)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, attendance.userId))
    .where(and(eq(attendance.organizationId, r.orgId), inArray(attendance.branchId, r.branchIds), gte(attendance.clockInAt, from), lt(attendance.clockInAt, to)));
  const monthly = await db
    .select()
    .from(staffProfiles)
    .where(and(eq(staffProfiles.organizationId, r.orgId), eq(staffProfiles.wageType, 'MONTHLY')));
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  let cost = 0;
  let hasData = false;
  const dayKeys = new Set<string>();
  for (const { a, p } of recs) {
    if (!p?.wageType || !p.wageRateSatang || !a.clockOutAt) continue;
    hasData = true;
    if (p.wageType === 'HOURLY') cost += Math.round(((a.clockOutAt.getTime() - a.clockInAt.getTime()) / 3_600_000) * p.wageRateSatang);
    else if (p.wageType === 'DAILY') {
      const k = `${a.userId}:${a.clockInAt.toISOString().slice(0, 10)}`;
      if (!dayKeys.has(k)) {
        dayKeys.add(k);
        cost += p.wageRateSatang;
      }
    }
  }
  const staffInScope = new Set((await Promise.all(r.branchIds.map((b) => branchStaffIds(db, b)))).flat());
  for (const p of monthly) {
    if (!p.wageRateSatang || !staffInScope.has(p.userId)) continue;
    hasData = true;
    cost += Math.round((p.wageRateSatang * days) / 30);
  }
  return hasData
    ? { available: true, costSatang: cost, note: 'คำนวณจากเวลาเข้า-ออกงานและอัตราค่าจ้าง (รายเดือนคิดตามสัดส่วนวัน) ไม่รวม OT/ประกันสังคม/ภาษี' }
    : { available: false, costSatang: 0, note: 'ยังไม่มีอัตราค่าจ้างหรือเวลาเข้า-ออกงาน' };
}

export default async function staffRoutes(app: FastifyInstance) {
  const { db } = app.deps;
  laborCostProvider.fn = computeLaborCost;

  // ---------- Staff profiles ----------
  app.get('/staff', async (req) => {
    const a = requirePerm(req, 'staff.manage');
    const branchId = requireBranch(a);
    const ids = await branchStaffIds(db, branchId);
    if (!ids.length) return { staff: [] };
    const rows = await db
      .select({ u: { id: users.id, name: users.name, phone: users.phone, isActive: users.isActive }, p: staffProfiles })
      .from(users)
      .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(inArray(users.id, ids), eq(users.organizationId, a.orgId)))
      .orderBy(asc(users.name));
    const roleRows = await db
      .select({ userId: userRoles.userId, name: roles.name, branchId: userRoles.branchId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(inArray(userRoles.userId, ids));
    const canSeePay = a.permissions.has('report.view_staff') || a.permissions.has('user.manage');
    return {
      staff: rows.map((r) => ({
        ...r.u,
        position: r.p?.position ?? null,
        wageType: canSeePay ? (r.p?.wageType ?? null) : null,
        wageRateSatang: canSeePay ? (r.p?.wageRateSatang ?? null) : null,
        startDate: r.p?.startDate ?? null,
        roles: roleRows.filter((x) => x.userId === r.u.id && (x.branchId === null || x.branchId === branchId)).map((x) => x.name),
      })),
    };
  });

  app.put('/staff/:userId/profile', async (req) => {
    const a = requirePerm(req, 'staff.manage');
    const branchId = requireBranch(a);
    const { userId } = parse(z.object({ userId: uuid }), req.params);
    const body = parse(
      z.object({
        position: z.string().trim().max(60).nullable().optional(),
        wageType: z.enum(['HOURLY', 'DAILY', 'MONTHLY']).nullable().optional(),
        wageRateSatang: satang.nullable().optional(),
        startDate: dateString.nullable().optional(),
        emergencyContact: z.string().trim().max(200).nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
      }),
      req.body,
    );
    if (!(await branchStaffIds(db, branchId)).includes(userId)) throw notFound('พนักงานในสาขานี้');
    // Pay data is sensitive: only users who may see staff reports or manage users can set it.
    if ((body.wageRateSatang !== undefined || body.wageType !== undefined) && !a.permissions.has('report.view_staff') && !a.permissions.has('user.manage')) throw forbidden('ไม่มีสิทธิ์แก้ไขค่าจ้าง');
    await db
      .insert(staffProfiles)
      .values({ userId, organizationId: a.orgId, ...body })
      .onConflictDoUpdate({ target: staffProfiles.userId, set: body });
    await audit(db, a, { action: 'staff.profile_update', targetType: 'user', targetId: userId, data: { fields: Object.keys(body) } }, req.ip);
    return { ok: true };
  });

  // ---------- Schedules ----------
  app.get('/schedules', async (req) => {
    const a = requireAnyPerm(req, 'staff.manage', 'attendance.self');
    const branchId = requireBranch(a);
    const q = parse(z.object({ from: dateString, to: dateString }), req.query);
    const s = await branchSettings(db, branchId);
    const [from, to] = localRange(q.from, q.to, s.timezone);
    const conds: SQL[] = [eq(staffShifts.branchId, branchId), gte(staffShifts.startsAt, from), lt(staffShifts.startsAt, to)];
    if (!a.permissions.has('staff.manage')) conds.push(eq(staffShifts.userId, a.userId));
    const rows = await db
      .select({ s: staffShifts, name: users.name })
      .from(staffShifts)
      .innerJoin(users, eq(users.id, staffShifts.userId))
      .where(and(...conds))
      .orderBy(asc(staffShifts.startsAt));
    return { shifts: rows.map((r) => ({ ...r.s, name: r.name })) };
  });

  const shiftBody = z.object({ userId: uuid, startsAt: iso, endsAt: iso, position: z.string().max(60).nullable().optional(), note: z.string().max(300).nullable().optional() });

  const assertShift = async (orgId: string, branchId: string, b: z.infer<typeof shiftBody>, excludeId?: string) => {
    const start = new Date(b.startsAt);
    const end = new Date(b.endsAt);
    if (end <= start) throw badRequest('เวลาเลิกต้องหลังเวลาเริ่ม');
    if (end.getTime() - start.getTime() > 16 * 3_600_000) throw badRequest('กะยาวเกิน 16 ชั่วโมง');
    if (!(await branchStaffIds(db, branchId)).includes(b.userId)) throw badRequest('พนักงานคนนี้ไม่ได้อยู่ในสาขานี้');
    // A person cannot be scheduled twice at the same time, in any branch.
    const [clash] = await db
      .select({ id: staffShifts.id })
      .from(staffShifts)
      .where(and(eq(staffShifts.organizationId, orgId), eq(staffShifts.userId, b.userId), lt(staffShifts.startsAt, end), sql`${staffShifts.endsAt} > ${start.toISOString()}::timestamptz`, excludeId ? ne(staffShifts.id, excludeId) : undefined));
    if (clash) throw conflict('พนักงานมีกะซ้อนในช่วงเวลานี้แล้ว', 'SHIFT_OVERLAP');
  };

  app.post('/schedules', async (req) => {
    const a = requirePerm(req, 'staff.manage');
    const branchId = requireBranch(a);
    const body = parse(shiftBody, req.body);
    await assertShift(a.orgId, branchId, body);
    const [s] = await db
      .insert(staffShifts)
      .values({ organizationId: a.orgId, branchId, userId: body.userId, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), position: body.position ?? null, note: body.note ?? null, createdBy: a.userId })
      .returning();
    await audit(db, a, { action: 'schedule.create', targetType: 'staff_shift', targetId: s.id, data: body }, req.ip);
    return s;
  });

  app.put('/schedules/:id', async (req) => {
    const a = requirePerm(req, 'staff.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(shiftBody, req.body);
    await assertShift(a.orgId, branchId, body, id);
    const [s] = await db
      .update(staffShifts)
      .set({ userId: body.userId, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), position: body.position ?? null, note: body.note ?? null })
      .where(and(eq(staffShifts.id, id), eq(staffShifts.branchId, branchId)))
      .returning();
    if (!s) throw notFound('กะ');
    await audit(db, a, { action: 'schedule.update', targetType: 'staff_shift', targetId: id, data: body }, req.ip);
    return s;
  });

  app.delete('/schedules/:id', async (req) => {
    const a = requirePerm(req, 'staff.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await db.delete(staffShifts).where(and(eq(staffShifts.id, id), eq(staffShifts.branchId, branchId))).returning({ id: staffShifts.id });
    if (!r.length) throw notFound('กะ');
    await audit(db, a, { action: 'schedule.delete', targetType: 'staff_shift', targetId: id }, req.ip);
    return { ok: true };
  });

  // ---------- Attendance ----------
  app.get('/attendance/me', async (req) => {
    const a = requirePerm(req, 'attendance.self');
    const [open] = await db.select().from(attendance).where(and(eq(attendance.userId, a.userId), isNull(attendance.clockOutAt))).orderBy(desc(attendance.clockInAt)).limit(1);
    return { open: open ?? null };
  });

  app.post('/attendance/clock', async (req) => {
    const a = requirePerm(req, 'attendance.self');
    const branchId = requireBranch(a);
    const { action } = parse(z.object({ action: z.enum(['in', 'out']) }), req.body);
    const now = new Date();
    const rec = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'att:' + a.userId}))`);
      const [open] = await tx.select().from(attendance).where(and(eq(attendance.userId, a.userId), isNull(attendance.clockOutAt))).limit(1);
      if (action === 'in') {
        if (open) throw conflict('ลงเวลาเข้างานไว้แล้ว', 'ALREADY_IN');
        const [r] = await tx.insert(attendance).values({ organizationId: a.orgId, branchId, userId: a.userId, clockInAt: now, source: a.sessionKind === 'PIN' ? 'PIN' : 'WEB' }).returning();
        return r;
      }
      if (!open) throw conflict('ยังไม่ได้ลงเวลาเข้างาน', 'NOT_IN');
      const [r] = await tx.update(attendance).set({ clockOutAt: now }).where(eq(attendance.id, open.id)).returning();
      return r;
    });
    await audit(db, a, { action: `attendance.clock_${action}`, targetType: 'attendance', targetId: rec.id }, req.ip);
    return rec;
  });

  app.get('/attendance', async (req) => {
    const a = requireAnyPerm(req, 'attendance.manage', 'attendance.self');
    const branchId = requireBranch(a);
    const q = parse(z.object({ from: dateString, to: dateString, userId: uuid.optional() }), req.query);
    const s = await branchSettings(db, branchId);
    const [from, to] = localRange(q.from, q.to, s.timezone);
    const all = a.permissions.has('attendance.manage');
    const rows = await db
      .select({ r: attendance, name: users.name })
      .from(attendance)
      .innerJoin(users, eq(users.id, attendance.userId))
      .where(and(eq(attendance.branchId, branchId), gte(attendance.clockInAt, from), lt(attendance.clockInAt, to), all ? (q.userId ? eq(attendance.userId, q.userId) : undefined) : eq(attendance.userId, a.userId)))
      .orderBy(desc(attendance.clockInAt));
    // Lateness vs schedule (informational; no payroll rules applied).
    const sched = rows.length
      ? await db
          .select()
          .from(staffShifts)
          .where(and(eq(staffShifts.branchId, branchId), inArray(staffShifts.userId, [...new Set(rows.map((r) => r.r.userId))]), gte(staffShifts.startsAt, new Date(from.getTime() - 86_400_000)), lt(staffShifts.startsAt, to)))
      : [];
    return {
      records: rows.map(({ r, name }) => {
        const plan = sched.find((x) => x.userId === r.userId && Math.abs(x.startsAt.getTime() - r.clockInAt.getTime()) < 6 * 3_600_000);
        return {
          ...r,
          name,
          hours: r.clockOutAt ? Math.round(((r.clockOutAt.getTime() - r.clockInAt.getTime()) / 3_600_000) * 100) / 100 : null,
          scheduledStart: plan?.startsAt ?? null,
          lateMinutes: plan ? Math.max(0, Math.round((r.clockInAt.getTime() - plan.startsAt.getTime()) / 60_000)) : null,
        };
      }),
    };
  });

  app.patch('/attendance/:id', async (req) => {
    const a = requirePerm(req, 'attendance.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ clockInAt: iso, clockOutAt: iso.nullable(), reason: reasonSchema }), req.body);
    if (body.clockOutAt && body.clockOutAt <= body.clockInAt) throw badRequest('เวลาออกต้องหลังเวลาเข้า');
    const [before] = await db.select().from(attendance).where(and(eq(attendance.id, id), eq(attendance.branchId, branchId)));
    if (!before) throw notFound('เวลาเข้า-ออก');
    if (before.userId === a.userId) throw forbidden('แก้ไขเวลาของตัวเองไม่ได้');
    await db
      .update(attendance)
      .set({ clockInAt: new Date(body.clockInAt), clockOutAt: body.clockOutAt ? new Date(body.clockOutAt) : null, editedBy: a.userId, editReason: body.reason })
      .where(eq(attendance.id, id));
    await audit(db, a, { action: 'attendance.edit', targetType: 'attendance', targetId: id, reason: body.reason, data: { before: { in: before.clockInAt, out: before.clockOutAt }, after: body } }, req.ip);
    return { ok: true };
  });

  // ---------- Branch administration (organisation level) ----------
  const orgAdmin = async (req: Parameters<typeof requireAuth>[0]) => {
    const a = requireAuth(req);
    const orgWide = await resolvePermissions(db, a.userId, null);
    if (!orgWide.permissions.has('org.manage')) throw forbidden('ต้องมีสิทธิ์จัดการองค์กร (ระดับทุกสาขา)');
    return a;
  };

  app.get('/org/branches', async (req) => {
    const a = await orgAdmin(req);
    return { branches: await db.select().from(branches).where(eq(branches.organizationId, a.orgId)).orderBy(asc(branches.code)) };
  });

  const branchBody = z.object({
    name: nonEmpty(100),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'รหัสสาขา A-Z 0-9 ไม่เกิน 10 ตัว'),
    address: z.string().trim().max(500).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    taxId: z.string().regex(/^\d{13}$/).nullable().optional(),
    timezone: z.string().max(60).default('Asia/Bangkok'),
    isCentralKitchen: z.boolean().default(false),
  });

  app.post('/org/branches', async (req) => {
    const a = await orgAdmin(req);
    const body = parse(branchBody.extend({ copySettingsFromBranchId: uuid.optional() }), req.body);
    let settings = {} as typeof branches.$inferInsert['settings'];
    if (body.copySettingsFromBranchId) {
      const [src] = await db.select().from(branches).where(and(eq(branches.id, body.copySettingsFromBranchId), eq(branches.organizationId, a.orgId)));
      if (!src) throw badRequest('สาขาต้นแบบไม่ถูกต้อง');
      settings = src.settings;
    }
    try {
      const { copySettingsFromBranchId: _c, ...cols } = body;
      const [b] = await db.insert(branches).values({ organizationId: a.orgId, ...cols, settings }).returning();
      await audit(db, a, { action: 'branch.create', targetType: 'branch', targetId: b.id, data: cols, branchId: null }, req.ip);
      return b;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('รหัสสาขานี้ถูกใช้แล้ว');
      throw e;
    }
  });

  app.patch('/org/branches/:id', async (req) => {
    const a = await orgAdmin(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(branchBody.partial().extend({ archived: z.boolean().optional() }), req.body);
    const { archived, ...cols } = body;
    if (archived) {
      const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(sql`orders`).where(sql`branch_id = ${id}::uuid and status in ('OPEN','BILL_REQUESTED')`);
      if (open > 0) throw conflict('สาขายังมีบิลเปิดอยู่');
    }
    try {
      const [b] = await db
        .update(branches)
        .set({ ...cols, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
        .where(and(eq(branches.id, id), eq(branches.organizationId, a.orgId)))
        .returning();
      if (!b) throw notFound('สาขา');
      await audit(db, a, { action: 'branch.update', targetType: 'branch', targetId: id, data: body, branchId: null }, req.ip);
      return b;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('รหัสสาขานี้ถูกใช้แล้ว');
      throw e;
    }
  });
}
