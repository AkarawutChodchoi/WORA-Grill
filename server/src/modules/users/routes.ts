import { and, desc, eq, gte, ilike, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from '@shared/permissions';
import { emailSchema, nonEmpty, passwordSchema, pinSchema, uuid } from '@shared/validation';
import type { DbOrTx } from '../../db/client';
import { auditLogs, branches, rolePermissions, roles, sessions, userRoles, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { accessibleBranches, requirePerm, resolvePermissions, type AuthContext } from '../../lib/auth';
import { hashSecret } from '../../lib/crypto';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, parse } from '../../lib/errors';

const assignmentSchema = z.object({ roleId: uuid, branchId: uuid.nullable() });

/** Branch ids where the actor may manage users; `'ALL'` when they hold user.manage org-wide. */
async function manageableScope(db: DbOrTx, a: AuthContext): Promise<'ALL' | string[]> {
  const orgWide = await resolvePermissions(db, a.userId, null);
  if (orgWide.permissions.has('user.manage')) return 'ALL';
  const out: string[] = [];
  for (const b of await accessibleBranches(db, a.userId, a.orgId)) {
    if ((await resolvePermissions(db, a.userId, b.id)).permissions.has('user.manage')) out.push(b.id);
  }
  return out;
}

/** Prevent privilege escalation: the actor must already hold every permission of a role they grant. */
async function assertCanGrant(db: DbOrTx, a: AuthContext, scope: 'ALL' | string[], assignments: { roleId: string; branchId: string | null }[]) {
  for (const as of assignments) {
    const [role] = await db.select().from(roles).where(and(eq(roles.id, as.roleId), eq(roles.organizationId, a.orgId)));
    if (!role) throw badRequest('ไม่พบบทบาทที่เลือก');
    if (as.branchId === null && scope !== 'ALL') throw forbidden('กำหนดสิทธิ์ทุกสาขาได้เฉพาะผู้ที่มีสิทธิ์ระดับองค์กร');
    if (as.branchId !== null) {
      const [b] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.id, as.branchId), eq(branches.organizationId, a.orgId)));
      if (!b) throw badRequest('ไม่พบสาขาที่เลือก');
      if (scope !== 'ALL' && !scope.includes(as.branchId)) throw forbidden('คุณไม่มีสิทธิ์จัดการผู้ใช้ในสาขานี้');
    }
    const rolePerms = await db.select({ p: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, role.id));
    const mine = (await resolvePermissions(db, a.userId, as.branchId)).permissions;
    const missing = rolePerms.map((r) => r.p).filter((p) => !mine.has(p as Permission));
    if (missing.length) throw forbidden(`ไม่สามารถมอบบทบาท "${role.name}" ที่มีสิทธิ์เกินกว่าที่คุณมี`);
  }
}

async function loadUser(db: DbOrTx, a: AuthContext, scope: 'ALL' | string[], id: string) {
  const [u] = await db.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, a.orgId)));
  if (!u) throw notFound('ผู้ใช้');
  if (scope !== 'ALL') {
    const asg = await db.select({ branchId: userRoles.branchId }).from(userRoles).where(eq(userRoles.userId, id));
    // Branch managers may manage users that only belong to their branches.
    if (asg.some((x) => x.branchId === null || !scope.includes(x.branchId))) throw forbidden('ผู้ใช้นี้อยู่นอกขอบเขตที่คุณจัดการได้');
  }
  return u;
}

export default async function userRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  app.get('/permissions', async (req) => {
    requirePerm(req, 'user.manage');
    return { permissions: Object.entries(PERMISSIONS).map(([code, label]) => ({ code, label })) };
  });

  app.get('/branches', async (req) => {
    const a = requirePerm(req);
    return { branches: await accessibleBranches(db, a.userId, a.orgId) };
  });

  app.get('/roles', async (req) => {
    const a = requirePerm(req, 'user.manage');
    const rs = await db.select().from(roles).where(eq(roles.organizationId, a.orgId)).orderBy(roles.isSystem, roles.name);
    const perms = rs.length ? await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, rs.map((r) => r.id))) : [];
    return { roles: rs.map((r) => ({ ...r, permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission) })) };
  });

  const roleBody = z.object({
    name: nonEmpty(60),
    permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])).max(ALL_PERMISSIONS.length),
  });

  app.post('/roles', async (req) => {
    const a = requirePerm(req, 'user.manage');
    const body = parse(roleBody.extend({ code: z.string().trim().regex(/^[A-Z0-9_]{2,30}$/, 'รหัสใช้ A-Z 0-9 _') }), req.body);
    const orgWide = (await resolvePermissions(db, a.userId, null)).permissions;
    if (body.permissions.some((p) => !orgWide.has(p))) throw forbidden('ไม่สามารถสร้างบทบาทที่มีสิทธิ์เกินกว่าสิทธิ์ระดับองค์กรของคุณ');
    try {
      return await db.transaction(async (tx) => {
        const [r] = await tx.insert(roles).values({ organizationId: a.orgId, code: body.code, name: body.name }).returning();
        if (body.permissions.length) await tx.insert(rolePermissions).values(body.permissions.map((permission) => ({ roleId: r.id, permission })));
        await audit(tx, a, { action: 'role.create', targetType: 'role', targetId: r.id, data: { code: body.code, permissions: body.permissions } }, req.ip);
        return r;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('รหัสบทบาทนี้มีอยู่แล้ว');
      throw e;
    }
  });

  app.put('/roles/:id', async (req) => {
    const a = requirePerm(req, 'user.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(roleBody, req.body);
    const [r] = await db.select().from(roles).where(and(eq(roles.id, id), eq(roles.organizationId, a.orgId)));
    if (!r) throw notFound('บทบาท');
    if (r.isSystem) throw forbidden('บทบาทระบบแก้ไขไม่ได้ สร้างบทบาทใหม่แทน');
    const orgWide = (await resolvePermissions(db, a.userId, null)).permissions;
    if (body.permissions.some((p) => !orgWide.has(p))) throw forbidden('ไม่สามารถให้สิทธิ์เกินกว่าสิทธิ์ระดับองค์กรของคุณ');
    await db.transaction(async (tx) => {
      await tx.update(roles).set({ name: body.name }).where(eq(roles.id, id));
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (body.permissions.length) await tx.insert(rolePermissions).values(body.permissions.map((permission) => ({ roleId: id, permission })));
      await audit(tx, a, { action: 'role.update', targetType: 'role', targetId: id, data: { permissions: body.permissions } }, req.ip);
    });
    return { ok: true };
  });

  app.get('/users', async (req) => {
    const a = requirePerm(req, 'user.manage');
    const scope = await manageableScope(db, a);
    const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const conds: SQL[] = [eq(users.organizationId, a.orgId)];
    if (q.q) conds.push(or(ilike(users.name, `%${q.q}%`), ilike(users.email, `%${q.q}%`))!);
    const list = await db
      .select({ id: users.id, name: users.name, email: users.email, phone: users.phone, isActive: users.isActive, hasPin: users.pinHash, lastLoginAt: users.lastLoginAt, lockedUntil: users.lockedUntil })
      .from(users)
      .where(and(...conds))
      .orderBy(users.name);
    const asg = list.length
      ? await db
          .select({ userId: userRoles.userId, roleId: userRoles.roleId, branchId: userRoles.branchId, roleCode: roles.code, roleName: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(inArray(userRoles.userId, list.map((u) => u.id)))
      : [];
    return {
      users: list
        .map((u) => ({ ...u, hasPin: !!u.hasPin, roles: asg.filter((x) => x.userId === u.id).map(({ userId: _u, ...r }) => r) }))
        .filter((u) => scope === 'ALL' || (u.roles.length > 0 && u.roles.every((r) => r.branchId && scope.includes(r.branchId)))),
    };
  });

  const userBody = z.object({
    name: nonEmpty(100),
    email: emailSchema.nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    password: passwordSchema.optional(),
    pin: pinSchema.optional(),
  });

  app.post('/users', async (req) => {
    const a = requirePerm(req, 'user.manage');
    const scope = await manageableScope(db, a);
    const body = parse(userBody.extend({ roles: z.array(assignmentSchema).min(1, 'เลือกอย่างน้อย 1 บทบาท').max(20) }), req.body);
    if (!body.email && !body.pin) throw badRequest('ต้องมีอีเมล+รหัสผ่าน หรือ PIN อย่างน้อยหนึ่งอย่าง');
    if (body.email && !body.password) throw badRequest('กรุณาตั้งรหัสผ่านสำหรับอีเมลนี้');
    await assertCanGrant(db, a, scope, body.roles);
    try {
      return await db.transaction(async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({
            organizationId: a.orgId,
            name: body.name,
            email: body.email ?? null,
            phone: body.phone ?? null,
            passwordHash: body.password ? await hashSecret(body.password) : null,
            pinHash: body.pin ? await hashSecret(body.pin) : null,
          })
          .returning({ id: users.id });
        await tx.insert(userRoles).values(body.roles.map((r) => ({ userId: u.id, roleId: r.roleId, branchId: r.branchId })));
        await audit(tx, a, { action: 'user.create', targetType: 'user', targetId: u.id, data: { name: body.name, email: body.email, roles: body.roles } }, req.ip);
        return u;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('อีเมลนี้ถูกใช้แล้ว');
      throw e;
    }
  });

  app.patch('/users/:id', async (req) => {
    const a = requirePerm(req, 'user.manage');
    const scope = await manageableScope(db, a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(userBody.partial().extend({ isActive: z.boolean().optional(), unlock: z.boolean().optional() }), req.body);
    const target = await loadUser(db, a, scope, id);
    if (id === a.userId && body.isActive === false) throw badRequest('ปิดใช้งานบัญชีของตัวเองไม่ได้');
    const targetRoles = (await resolvePermissions(db, id, null)).roles;
    if (targetRoles.includes('OWNER') && !a.roles.includes('OWNER')) throw forbidden('เฉพาะเจ้าของเท่านั้นที่แก้ไขบัญชีเจ้าของได้');
    // Changing credentials/status of someone is only allowed if the actor holds every permission they have
    // (otherwise resetting their password would be a privilege escalation).
    const current = await db.select({ roleId: userRoles.roleId, branchId: userRoles.branchId }).from(userRoles).where(eq(userRoles.userId, id));
    if (id !== a.userId) await assertCanGrant(db, a, scope, current);
    const set: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.email !== undefined) set.email = body.email;
    if (body.phone !== undefined) set.phone = body.phone;
    if (body.isActive !== undefined) set.isActive = body.isActive;
    if (body.password) set.passwordHash = await hashSecret(body.password);
    if (body.pin) set.pinHash = await hashSecret(body.pin);
    if (body.unlock) Object.assign(set, { failedLoginCount: 0, lockedUntil: null });
    try {
      await db.transaction(async (tx) => {
        if (Object.keys(set).length) await tx.update(users).set(set).where(eq(users.id, id));
        if (body.isActive === false || body.password) await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
        await audit(
          tx,
          a,
          {
            action: 'user.update',
            targetType: 'user',
            targetId: id,
            data: { name: body.name, email: body.email, isActive: body.isActive, passwordReset: !!body.password, pinReset: !!body.pin, unlock: body.unlock, previousName: target.name },
          },
          req.ip,
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('อีเมลนี้ถูกใช้แล้ว');
      throw e;
    }
    return { ok: true };
  });

  app.put('/users/:id/roles', async (req) => {
    const a = requirePerm(req, 'user.manage');
    const scope = await manageableScope(db, a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ roles: z.array(assignmentSchema).max(20) }), req.body);
    await loadUser(db, a, scope, id);
    if (id === a.userId) throw forbidden('แก้ไขบทบาทของตัวเองไม่ได้');
    const current = await db.select({ roleId: userRoles.roleId, branchId: userRoles.branchId, code: roles.code }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, id));
    if (current.some((c) => c.code === 'OWNER') && !a.roles.includes('OWNER')) throw forbidden('เฉพาะเจ้าของเท่านั้นที่แก้ไขบทบาทเจ้าของได้');
    // Removing roles also requires holding them (otherwise a manager could strip an owner-level role).
    await assertCanGrant(db, a, scope, [...body.roles, ...current.map((c) => ({ roleId: c.roleId, branchId: c.branchId }))]);
    await db.transaction(async (tx) => {
      await tx.delete(userRoles).where(eq(userRoles.userId, id));
      if (body.roles.length) await tx.insert(userRoles).values(body.roles.map((r) => ({ userId: id, roleId: r.roleId, branchId: r.branchId }))).onConflictDoNothing();
      await audit(tx, a, { action: 'user.roles_changed', targetType: 'user', targetId: id, data: { before: current, after: body.roles } }, req.ip);
    });
    return { ok: true };
  });

  app.get('/audit-logs', async (req) => {
    const a = requirePerm(req, 'audit.view');
    const q = parse(
      z.object({
        action: z.string().max(60).optional(),
        actorUserId: uuid.optional(),
        targetId: z.string().max(80).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().datetime({ offset: true }).optional(),
      }),
      req.query,
    );
    const orgWide = (await resolvePermissions(db, a.userId, null)).permissions.has('audit.view');
    const conds: SQL[] = [eq(auditLogs.organizationId, a.orgId)];
    if (!orgWide) conds.push(a.branchId ? eq(auditLogs.branchId, a.branchId) : isNull(auditLogs.id));
    if (q.action) conds.push(ilike(auditLogs.action, `${q.action}%`));
    if (q.actorUserId) conds.push(eq(auditLogs.actorUserId, q.actorUserId));
    if (q.targetId) conds.push(eq(auditLogs.targetId, q.targetId));
    if (q.from) conds.push(gte(auditLogs.createdAt, new Date(q.from)));
    if (q.to) conds.push(lt(auditLogs.createdAt, new Date(q.to)));
    if (q.before) conds.push(lt(auditLogs.createdAt, new Date(q.before)));
    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        reason: auditLogs.reason,
        data: auditLogs.data,
        createdAt: auditLogs.createdAt,
        branchId: auditLogs.branchId,
        actorUserId: auditLogs.actorUserId,
        approverUserId: auditLogs.approverUserId,
      })
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.limit);
    const ids = [...new Set(rows.flatMap((r) => [r.actorUserId, r.approverUserId]).filter((x): x is string => !!x))];
    const names = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
    const nameOf = (id: string | null) => (id ? (names.find((n) => n.id === id)?.name ?? '?') : null);
    return { logs: rows.map((r) => ({ ...r, actorName: nameOf(r.actorUserId), approverName: nameOf(r.approverUserId) })) };
  });
}
