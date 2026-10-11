import type { DbOrTx } from '../db/client';
import { auditLogs } from '../db/schema';
import type { AuthContext } from './auth';

const SECRET_KEYS = /pass(word)?|pin|token|secret|card|cvv|authorization/i;

/** Strip anything that looks like a secret before it is persisted in the audit trail. */
export function redact(data: unknown, depth = 0): unknown {
  if (depth > 5 || data === null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((d) => redact(d, depth + 1));
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1)]));
}

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string | null;
  reason?: string | null;
  data?: Record<string, unknown>;
  approverUserId?: string | null;
  branchId?: string | null;
}

/** Write an audit record, normally inside the same transaction as the change it describes. */
export async function audit(db: DbOrTx, actor: Pick<AuthContext, 'orgId' | 'branchId' | 'userId'> | { orgId: string; branchId: string | null; userId: string | null }, e: AuditEntry, ip?: string) {
  await db.insert(auditLogs).values({
    organizationId: actor.orgId,
    branchId: e.branchId === undefined ? actor.branchId : e.branchId,
    actorUserId: actor.userId,
    approverUserId: e.approverUserId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    reason: e.reason ?? null,
    data: e.data ? (redact(e.data) as Record<string, unknown>) : null,
    ip: ip ?? null,
  });
}
