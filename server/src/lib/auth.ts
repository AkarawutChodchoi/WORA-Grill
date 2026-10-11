import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APPROVABLE_PERMISSIONS, type Permission } from '@shared/permissions';
import type { DbOrTx } from '../db/client';
import { auditLogs, branches, devices, rolePermissions, roles, sessions, userRoles, users } from '../db/schema';
import { sha256, verifySecret } from './crypto';
import { badRequest, forbidden, tooMany, unauthorized } from './errors';
import { RateLimiter } from './rate-limit';

export const SESSION_COOKIE = 'rms_session';
export const DEVICE_COOKIE = 'rms_device';

export interface AuthContext {
  userId: string;
  name: string;
  orgId: string;
  branchId: string | null;
  sessionId: string;
  sessionKind: 'PASSWORD' | 'PIN';
  deviceId: string | null;
  roles: string[];
  permissions: Set<Permission>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** Roles + permissions the user holds in a branch (org-wide assignments always apply). */
export async function resolvePermissions(db: DbOrTx, userId: string, branchId: string | null) {
  const rows = await db
    .select({ code: roles.code, permission: rolePermissions.permission })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(and(eq(userRoles.userId, userId), branchId ? or(isNull(userRoles.branchId), eq(userRoles.branchId, branchId)) : isNull(userRoles.branchId)));
  const permissions = new Set<Permission>();
  const roleCodes = new Set<string>();
  for (const r of rows) {
    roleCodes.add(r.code);
    if (r.permission) permissions.add(r.permission as Permission);
  }
  return { permissions, roles: [...roleCodes] };
}

/** Branches the user may work in: all org branches if they hold any org-wide role, else assigned ones. */
export async function accessibleBranches(db: DbOrTx, userId: string, orgId: string) {
  const assignments = await db.select({ branchId: userRoles.branchId }).from(userRoles).where(eq(userRoles.userId, userId));
  const orgWide = assignments.some((a) => a.branchId === null);
  const ids = assignments.map((a) => a.branchId).filter((x): x is string => !!x);
  if (!orgWide && ids.length === 0) return [];
  return db
    .select({ id: branches.id, code: branches.code, name: branches.name })
    .from(branches)
    .where(and(eq(branches.organizationId, orgId), isNull(branches.archivedAt), orgWide ? undefined : inArray(branches.id, ids)))
    .orderBy(branches.code);
}

export async function canAccessBranch(db: DbOrTx, userId: string, orgId: string, branchId: string) {
  return (await accessibleBranches(db, userId, orgId)).some((b) => b.id === branchId);
}

const SLIDE_MS = 5 * 60 * 1000;

/** Load the session from the cookie. Returns null when absent/expired/revoked or the user is inactive. */
export async function loadAuth(db: DbOrTx, token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({ s: sessions, u: { id: users.id, name: users.name, isActive: users.isActive } })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row || !row.u.isActive) return null;
  if (row.s.deviceId) {
    const [d] = await db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, row.s.deviceId));
    if (!d || d.revokedAt) return null; // PIN sessions end when their terminal is revoked
  }
  if (now.getTime() - row.s.lastSeenAt.getTime() > SLIDE_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.s.id));
  }
  const { permissions, roles: roleCodes } = await resolvePermissions(db, row.u.id, row.s.branchId);
  return {
    userId: row.u.id,
    name: row.u.name,
    orgId: row.s.organizationId,
    branchId: row.s.branchId,
    sessionId: row.s.id,
    sessionKind: row.s.kind,
    deviceId: row.s.deviceId,
    roles: roleCodes,
    permissions,
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Require a signed-in user holding ALL listed permissions in the current branch. */
export function requirePerm(req: FastifyRequest, ...perms: Permission[]): AuthContext {
  const a = requireAuth(req);
  for (const p of perms) if (!a.permissions.has(p)) throw forbidden();
  return a;
}

export function requireAnyPerm(req: FastifyRequest, ...perms: Permission[]): AuthContext {
  const a = requireAuth(req);
  if (!perms.some((p) => a.permissions.has(p))) throw forbidden();
  return a;
}

export function requireBranch(a: AuthContext): string {
  if (!a.branchId) throw badRequest('กรุณาเลือกสาขาก่อนทำรายการ');
  return a.branchId;
}

export interface Approval {
  userId: string;
  pin: string;
}

const approvalLimiter = new RateLimiter(5, 5 * 60 * 1000);

export interface ApprovalFailure {
  approverId: string;
  orgId: string;
  branchId: string | null;
  actorId: string;
  permission: string;
}

/** Writes failed approval attempts with the root DB handle after the current transaction ends (set by buildApp). */
let approvalFailureRecorder: (f: ApprovalFailure) => void = () => undefined;
export function setApprovalFailureRecorder(db: DbOrTx, onError: (e: unknown) => void) {
  approvalFailureRecorder = (f) => {
    setTimeout(() => {
      void (async () => {
        const [u] = await db.select({ failed: users.failedLoginCount }).from(users).where(eq(users.id, f.approverId));
        const n = (u?.failed ?? 0) + 1;
        await db
          .update(users)
          .set({ failedLoginCount: n, lockedUntil: n >= 5 ? new Date(Date.now() + 15 * 60_000) : null })
          .where(eq(users.id, f.approverId));
        await db.insert(auditLogs).values({ organizationId: f.orgId, branchId: f.branchId, actorUserId: f.actorId, approverUserId: f.approverId, action: 'approval.pin_failed', data: { permission: f.permission, attempts: n } });
      })().catch(onError);
    }, 0);
  };
}

/**
 * Authorise a sensitive action (SPEC §2: void / discount / open drawer need a manager PIN).
 * The actor passes if they hold `perm`; otherwise a manager in the same branch may approve it with
 * their PIN. Returns the approver's user id (or null when the actor was authorised directly).
 */
export async function authorizeSensitive(db: DbOrTx, a: AuthContext, perm: Permission, approval?: Approval | null): Promise<string | null> {
  if (a.permissions.has(perm)) return null;
  if (!approval || !APPROVABLE_PERMISSIONS.includes(perm)) throw forbidden('ต้องได้รับอนุมัติจากผู้จัดการ (PIN)');
  const key = `${a.orgId}:${approval.userId}`;
  if (!approvalLimiter.take(key)) throw tooMany('ใส่ PIN ผิดหลายครั้ง กรุณารอ 5 นาที');
  const [approver] = await db
    .select({ id: users.id, pinHash: users.pinHash, isActive: users.isActive, orgId: users.organizationId, failed: users.failedLoginCount, lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, approval.userId))
    .limit(1);
  if (approver?.lockedUntil && approver.lockedUntil > new Date()) throw tooMany('PIN ผู้อนุมัติถูกล็อกชั่วคราวจากการใส่ผิดหลายครั้ง');
  const ok = await verifySecret(approval.pin, approver?.pinHash);
  if (!approver || !ok || !approver.isActive || approver.orgId !== a.orgId) {
    // Persistent lockout (shared with PIN sign-in). Recorded outside the caller's transaction, which is
    // about to roll back because of this very failure.
    if (approver && approver.orgId === a.orgId) approvalFailureRecorder({ approverId: approver.id, orgId: a.orgId, branchId: a.branchId, actorId: a.userId, permission: perm });
    throw forbidden('PIN ผู้อนุมัติไม่ถูกต้อง');
  }
  if (approver.failed) await db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, approver.id));
  const { permissions } = await resolvePermissions(db, approver.id, a.branchId);
  if (!permissions.has(perm)) throw forbidden('ผู้อนุมัติไม่มีสิทธิ์สำหรับรายการนี้');
  approvalLimiter.reset(key);
  return approver.id;
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSec: number, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: maxAgeSec });
}
