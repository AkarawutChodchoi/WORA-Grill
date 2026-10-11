import { and, count, eq, isNotNull, isNull, or, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { emailSchema, nonEmpty, passwordSchema, pinSchema, uuid } from '@shared/validation';
import { branches, devices, organizations, sessions, userRoles, users } from '../../db/schema';
import { DEVICE_KINDS } from '../../db/schema/devices';
import { audit } from '../../lib/audit';
import {
  accessibleBranches,
  canAccessBranch,
  DEVICE_COOKIE,
  requireAuth,
  requirePerm,
  resolvePermissions,
  SESSION_COOKIE,
  setSessionCookie,
} from '../../lib/auth';
import { hashSecret, randomToken, sha256, verifySecret } from '../../lib/crypto';
import { AppError, conflict, forbidden, parse, tooMany, unauthorized } from '../../lib/errors';
import { RateLimiter } from '../../lib/rate-limit';
import { bootstrapOrganization } from './bootstrap';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const ipLimiter = new RateLimiter(30, 10 * 60 * 1000);

async function startSession(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  user: { id: string; organizationId: string },
  kind: 'PASSWORD' | 'PIN',
  branchId: string | null,
  deviceId: string | null = null,
) {
  const { db, config } = app.deps;
  const token = randomToken();
  const ttlSec = config.SESSION_TTL_HOURS * 3600;
  await db.insert(sessions).values({
    tokenHash: sha256(token),
    userId: user.id,
    organizationId: user.organizationId,
    branchId,
    kind,
    deviceId,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 300),
    expiresAt: new Date(Date.now() + ttlSec * 1000),
  });
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  setSessionCookie(reply, token, ttlSec, config.COOKIE_SECURE === 'true');
}

async function registerFailure(app: FastifyInstance, userId: string, failed: number) {
  const n = failed + 1;
  await app.deps.db
    .update(users)
    .set({ failedLoginCount: n, lockedUntil: n >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
    .where(eq(users.id, userId));
}

/** Resolve the paired terminal device from its cookie. */
async function loadDevice(app: FastifyInstance, req: FastifyRequest) {
  const token = req.cookies[DEVICE_COOKIE];
  if (!token) return null;
  const [d] = await app.deps.db
    .select()
    .from(devices)
    .where(and(eq(devices.tokenHash, sha256(token)), isNull(devices.revokedAt)))
    .limit(1);
  return d ?? null;
}

export default async function authRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  // ---- First-run setup (only while no organisation exists) ----
  app.get('/setup/status', async () => {
    const [{ n }] = await db.select({ n: count() }).from(organizations);
    return { needsSetup: n === 0 };
  });

  app.post('/setup', async (req, reply) => {
    if (!ipLimiter.take(`setup:${req.ip}`)) throw tooMany();
    const body = parse(
      z.object({
        orgName: nonEmpty(),
        branchName: nonEmpty(),
        branchCode: z.string().trim().min(1).max(20).default('HQ'),
        ownerName: nonEmpty(),
        email: emailSchema,
        password: passwordSchema,
        pin: pinSchema.optional(),
      }),
      req.body,
    );
    const result = await db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: count() }).from(organizations);
      if (n > 0) throw conflict('ระบบถูกตั้งค่าแล้ว');
      return bootstrapOrganization(tx, {
        orgName: body.orgName,
        branchName: body.branchName,
        branchCode: body.branchCode,
        owner: { name: body.ownerName, email: body.email, password: body.password, pin: body.pin },
      });
    });
    await audit(db, { orgId: result.org.id, branchId: result.branch.id, userId: result.owner.id }, { action: 'org.setup', targetType: 'organization', targetId: result.org.id }, req.ip);
    await startSession(app, req, reply, result.owner, 'PASSWORD', result.branch.id);
    return { ok: true };
  });

  // ---- Email + password (back office) ----
  app.post('/auth/login', async (req, reply) => {
    if (!ipLimiter.take(`login:${req.ip}`)) throw tooMany();
    const body = parse(z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }), req.body);
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const ok = await verifySecret(body.password, u?.passwordHash);
    if (u && u.lockedUntil && u.lockedUntil > new Date()) throw new AppError(423, 'LOCKED', 'บัญชีถูกล็อกชั่วคราวจากการเข้าสู่ระบบผิดหลายครั้ง ลองใหม่ภายหลัง');
    if (!u || !ok || !u.isActive) {
      if (u) await registerFailure(app, u.id, u.failedLoginCount);
      throw unauthorized('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    const brs = await accessibleBranches(db, u.id, u.organizationId);
    await startSession(app, req, reply, u, 'PASSWORD', brs[0]?.id ?? null);
    await audit(db, { orgId: u.organizationId, branchId: brs[0]?.id ?? null, userId: u.id }, { action: 'auth.login' }, req.ip);
    return { ok: true };
  });

  // ---- PIN sign-in on a paired terminal (front of house, SPEC §3.17) ----
  app.get('/auth/terminal', async (req) => {
    const d = await loadDevice(app, req);
    if (!d) return { paired: false };
    const [b] = await db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.id, d.branchId));
    return { paired: true, device: { id: d.id, name: d.name, kind: d.kind }, branch: b };
  });

  app.get('/auth/pin-users', async (req) => {
    const d = await loadDevice(app, req);
    if (!d) throw forbidden('อุปกรณ์นี้ยังไม่ได้ลงทะเบียนเป็นเครื่องหน้าร้าน');
    const rows = await db
      .selectDistinct({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(
        and(
          eq(users.organizationId, d.organizationId),
          eq(users.isActive, true),
          isNotNull(users.pinHash),
          or(isNull(userRoles.branchId), eq(userRoles.branchId, d.branchId)),
        ),
      )
      .orderBy(users.name);
    return { users: rows };
  });

  app.post('/auth/pin-login', async (req, reply) => {
    if (!ipLimiter.take(`pin:${req.ip}`)) throw tooMany();
    const d = await loadDevice(app, req);
    if (!d) throw forbidden('อุปกรณ์นี้ยังไม่ได้ลงทะเบียนเป็นเครื่องหน้าร้าน');
    const body = parse(z.object({ userId: uuid, pin: z.string().max(10) }), req.body);
    const [u] = await db.select().from(users).where(and(eq(users.id, body.userId), eq(users.organizationId, d.organizationId))).limit(1);
    if (u?.lockedUntil && u.lockedUntil > new Date()) throw new AppError(423, 'LOCKED', 'ใส่ PIN ผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว');
    const ok = await verifySecret(body.pin, u?.pinHash);
    if (!u || !ok || !u.isActive) {
      if (u) await registerFailure(app, u.id, u.failedLoginCount);
      throw unauthorized('PIN ไม่ถูกต้อง');
    }
    if (!(await canAccessBranch(db, u.id, u.organizationId, d.branchId))) throw forbidden('ผู้ใช้นี้ไม่มีสิทธิ์ในสาขานี้');
    await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, d.id));
    // Signing in on a terminal ends the previous user's session there (fast staff switching).
    const prev = req.cookies[SESSION_COOKIE];
    if (prev) await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256(prev)));
    await startSession(app, req, reply, u, 'PIN', d.branchId, d.id);
    await audit(db, { orgId: u.organizationId, branchId: d.branchId, userId: u.id }, { action: 'auth.pin_login', targetType: 'device', targetId: d.id }, req.ip);
    return { ok: true };
  });

  /** Pair this browser as a terminal for the current branch (manager action). */
  app.post('/auth/terminal', async (req, reply) => {
    const a = requirePerm(req, 'device.manage');
    if (!a.branchId) throw forbidden('เลือกสาขาก่อน');
    const body = parse(z.object({ name: nonEmpty(80), kind: z.enum(DEVICE_KINDS).default('POS') }), req.body);
    const token = randomToken();
    const [d] = await db
      .insert(devices)
      .values({ organizationId: a.orgId, branchId: a.branchId, name: body.name, kind: body.kind, tokenHash: sha256(token), createdBy: a.userId })
      .returning({ id: devices.id });
    reply.setCookie(DEVICE_COOKIE, token, {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'strict',
      secure: app.deps.config.COOKIE_SECURE === 'true',
      maxAge: 365 * 24 * 3600,
    });
    await audit(db, a, { action: 'device.pair', targetType: 'device', targetId: d.id, data: { name: body.name, kind: body.kind } }, req.ip);
    return { id: d.id };
  });

  app.delete('/auth/terminal', async (req, reply) => {
    requireAuth(req);
    reply.clearCookie(DEVICE_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  // ---- Session ----
  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256(token)));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (req.auth) await audit(db, req.auth, { action: 'auth.logout' }, req.ip);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const a = requireAuth(req);
    const [[u], [org], brs] = await Promise.all([
      db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, a.userId)),
      db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, a.orgId)),
      accessibleBranches(db, a.userId, a.orgId),
    ]);
    return {
      user: u,
      organization: org,
      branch: brs.find((b) => b.id === a.branchId) ?? null,
      branches: brs,
      roles: a.roles,
      permissions: [...a.permissions].sort(),
      sessionKind: a.sessionKind,
    };
  });

  app.post('/auth/branch', async (req) => {
    const a = requireAuth(req);
    const body = parse(z.object({ branchId: uuid }), req.body);
    if (!(await canAccessBranch(db, a.userId, a.orgId, body.branchId))) throw forbidden('คุณไม่มีสิทธิ์ในสาขานี้');
    if (a.sessionKind === 'PIN') throw forbidden('เครื่องหน้าร้านผูกกับสาขาเดียว');
    await db.update(sessions).set({ branchId: body.branchId }).where(eq(sessions.id, a.sessionId));
    return { ok: true };
  });

  app.post('/auth/password', async (req) => {
    const a = requireAuth(req);
    const body = parse(z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }), req.body);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId));
    if (!(await verifySecret(body.currentPassword, u.passwordHash))) throw unauthorized('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    await db.update(users).set({ passwordHash: await hashSecret(body.newPassword) }).where(eq(users.id, a.userId));
    // Revoke other sessions after a password change.
    const others = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, a.userId), isNull(sessions.revokedAt)));
    const ids = others.map((s) => s.id).filter((id) => id !== a.sessionId);
    if (ids.length) await db.update(sessions).set({ revokedAt: new Date() }).where(inArray(sessions.id, ids));
    await audit(db, a, { action: 'auth.password_changed', targetType: 'user', targetId: a.userId }, req.ip);
    return { ok: true };
  });

  /** List users who may approve a given permission in the current branch (for the manager-PIN dialog). */
  app.get('/auth/approvers', async (req) => {
    const a = requireAuth(req);
    const { permission } = parse(z.object({ permission: z.string().max(60) }), req.query);
    const candidates = await db
      .selectDistinct({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(
        and(
          eq(users.organizationId, a.orgId),
          eq(users.isActive, true),
          isNotNull(users.pinHash),
          a.branchId ? or(isNull(userRoles.branchId), eq(userRoles.branchId, a.branchId)) : isNull(userRoles.branchId),
        ),
      );
    const out = [];
    for (const c of candidates) {
      const { permissions } = await resolvePermissions(db, c.id, a.branchId);
      if (permissions.has(permission as never)) out.push(c);
    }
    return { approvers: out };
  });
}
