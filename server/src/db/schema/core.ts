import { boolean, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common';
import type { BranchSettings, OrgSettings } from '@shared/settings';

export const organizations = pgTable('organizations', {
  id: pk(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<OrgSettings>().notNull().default({} as OrgSettings),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const branches = pgTable(
  'branches',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    taxId: text('tax_id'),
    timezone: text('timezone').notNull().default('Asia/Bangkok'),
    settings: jsonb('settings').$type<BranchSettings>().notNull().default({} as BranchSettings),
    isCentralKitchen: boolean('is_central_kitchen').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('branches_org_code_uq').on(t.organizationId, t.code)],
);

export const users = pgTable(
  'users',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    /** Lower-cased; null for PIN-only front-of-house staff. */
    email: text('email'),
    passwordHash: text('password_hash'),
    pinHash: text('pin_hash'),
    name: text('name').notNull(),
    phone: text('phone'),
    isActive: boolean('is_active').notNull().default(true),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), index('users_org_idx').on(t.organizationId)],
);

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('roles_org_code_uq').on(t.organizationId, t.code)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

/** A role granted to a user, either for one branch or (branch_id NULL) for every branch of the organisation. */
export const userRoles = pgTable(
  'user_roles',
  {
    id: pk(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id),
    createdAt: createdAt(),
  },
  (t) => [unique('user_roles_uq').on(t.userId, t.roleId, t.branchId).nullsNotDistinct(), index('user_roles_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    /** Active branch context for this session. */
    branchId: uuid('branch_id').references(() => branches.id),
    kind: text('kind', { enum: ['PASSWORD', 'PIN'] }).notNull(),
    deviceId: uuid('device_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').references(() => branches.id),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    approverUserId: uuid('approver_user_id').references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    reason: text('reason'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_org_created_idx').on(t.organizationId, t.createdAt),
    index('audit_branch_created_idx').on(t.branchId, t.createdAt),
    index('audit_target_idx').on(t.targetType, t.targetId),
  ],
);
