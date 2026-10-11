import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { notificationReads, notifications } from '../../db/schema';
import type { EventBus } from '../../lib/events';
import type { AuthContext } from '../../lib/auth';

export interface NewNotification {
  orgId: string;
  branchId: string | null;
  userId?: string | null;
  requiredPermission?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/** Store an in-app notification and nudge connected clients. */
export async function notify(db: DbOrTx, bus: EventBus | null, n: NewNotification) {
  const [row] = await db
    .insert(notifications)
    .values({ organizationId: n.orgId, branchId: n.branchId, userId: n.userId ?? null, requiredPermission: n.requiredPermission ?? null, kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null })
    .returning();
  bus?.publish({ type: 'notification', organizationId: n.orgId, branchId: n.branchId, payload: { id: row.id, kind: n.kind } });
  return row;
}

/** Notifications visible to this user in the current branch (last 7 days), with read flags. */
export async function listNotifications(db: DbOrTx, a: AuthContext) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({ n: notifications, readAt: notificationReads.readAt })
    .from(notifications)
    .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, a.userId)))
    .where(
      and(
        eq(notifications.organizationId, a.orgId),
        gt(notifications.createdAt, since),
        a.branchId ? or(eq(notifications.branchId, a.branchId), isNull(notifications.branchId)) : isNull(notifications.branchId),
        or(eq(notifications.userId, a.userId), isNull(notifications.userId)),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(100);
  return rows
    .filter((r) => !r.n.requiredPermission || a.permissions.has(r.n.requiredPermission as never))
    .map((r) => ({ ...r.n, read: !!r.readAt }));
}

