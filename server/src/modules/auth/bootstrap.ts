import { eq } from 'drizzle-orm';
import { DEFAULT_ROLE_PERMISSIONS, ROLE_LABELS, SYSTEM_ROLES, type SystemRole } from '@shared/permissions';
import type { DbOrTx } from '../../db/client';
import { branches, organizations, rolePermissions, roles, userRoles, users } from '../../db/schema';
import { hashSecret } from '../../lib/crypto';

/** Create (or top up) the built-in roles of an organisation. Returns code → role id. */
export async function ensureSystemRoles(db: DbOrTx, orgId: string): Promise<Record<SystemRole, string>> {
  const existing = await db.select().from(roles).where(eq(roles.organizationId, orgId));
  const out = {} as Record<SystemRole, string>;
  for (const code of SYSTEM_ROLES) {
    let role = existing.find((r) => r.code === code);
    if (!role) {
      [role] = await db.insert(roles).values({ organizationId: orgId, code, name: ROLE_LABELS[code], isSystem: true }).returning();
    }
    out[code] = role.id;
    const perms = DEFAULT_ROLE_PERMISSIONS[code];
    if (perms.length) {
      await db
        .insert(rolePermissions)
        .values(perms.map((permission) => ({ roleId: role.id, permission })))
        .onConflictDoNothing();
    }
  }
  return out;
}

export interface BootstrapInput {
  orgName: string;
  branchName: string;
  branchCode: string;
  owner: { name: string; email: string; password: string; pin?: string };
}

/** First-run setup: organisation, first branch, system roles and the owner account. */
export async function bootstrapOrganization(db: DbOrTx, input: BootstrapInput) {
  const [org] = await db.insert(organizations).values({ name: input.orgName }).returning();
  const [branch] = await db.insert(branches).values({ organizationId: org.id, name: input.branchName, code: input.branchCode }).returning();
  const roleIds = await ensureSystemRoles(db, org.id);
  const [owner] = await db
    .insert(users)
    .values({
      organizationId: org.id,
      name: input.owner.name,
      email: input.owner.email.toLowerCase(),
      passwordHash: await hashSecret(input.owner.password),
      pinHash: input.owner.pin ? await hashSecret(input.owner.pin) : null,
    })
    .returning();
  await db.insert(userRoles).values({ userId: owner.id, roleId: roleIds.OWNER, branchId: null });
  return { org, branch, owner, roleIds };
}
