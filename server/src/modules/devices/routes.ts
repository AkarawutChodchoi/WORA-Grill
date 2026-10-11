import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid } from '@shared/validation';
import { devices } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireBranch, requirePerm } from '../../lib/auth';
import { notFound, parse } from '../../lib/errors';

export default async function deviceRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  app.get('/devices', async (req) => {
    const a = requirePerm(req, 'device.manage');
    const branchId = requireBranch(a);
    const rows = await db
      .select({ id: devices.id, name: devices.name, kind: devices.kind, stationId: devices.stationId, config: devices.config, lastSeenAt: devices.lastSeenAt, revokedAt: devices.revokedAt, createdAt: devices.createdAt, paired: devices.tokenHash })
      .from(devices)
      .where(and(eq(devices.organizationId, a.orgId), eq(devices.branchId, branchId)))
      .orderBy(desc(devices.createdAt));
    return { devices: rows.map((d) => ({ ...d, paired: !!d.paired })) };
  });

  app.delete('/devices/:id', async (req) => {
    const a = requirePerm(req, 'device.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [d] = await db
      .update(devices)
      .set({ revokedAt: new Date(), tokenHash: null })
      .where(and(eq(devices.id, id), eq(devices.organizationId, a.orgId), eq(devices.branchId, requireBranch(a))))
      .returning({ id: devices.id });
    if (!d) throw notFound('อุปกรณ์');
    await audit(db, a, { action: 'device.revoke', targetType: 'device', targetId: id }, req.ip);
    return { ok: true };
  });
}
