import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid } from '@shared/validation';
import { devices, stations } from '../../db/schema';
import { audit } from '../../lib/audit';
import { requireBranch, requirePerm } from '../../lib/auth';
import { badRequest, notFound, parse } from '../../lib/errors';

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

  /** Bind a KDS device to a station (it will then only show and update that station's items). */
  app.patch('/devices/:id', async (req) => {
    const a = requirePerm(req, 'device.manage');
    const branchId = requireBranch(a);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ stationId: uuid.nullable().optional(), name: z.string().trim().min(1).max(80).optional(), config: z.record(z.string(), z.unknown()).optional() }), req.body);
    if (body.stationId) {
      const [s] = await db.select({ id: stations.id }).from(stations).where(and(eq(stations.id, body.stationId), eq(stations.branchId, branchId)));
      if (!s) throw badRequest('สเตชันไม่ถูกต้อง');
    }
    const [d] = await db
      .update(devices)
      .set(body)
      .where(and(eq(devices.id, id), eq(devices.organizationId, a.orgId), eq(devices.branchId, branchId)))
      .returning({ id: devices.id });
    if (!d) throw notFound('อุปกรณ์');
    await audit(db, a, { action: 'device.update', targetType: 'device', targetId: id, data: body }, req.ip);
    return { ok: true };
  });
}
