import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client';
import { seedDemoData } from '../src/db/seed-demo';
import { bootstrapOrganization } from '../src/modules/auth/bootstrap';
import { loadBranchMenu } from '../src/modules/menu/service';

describe('demo seed', () => {
  it('seeds a consistent demo restaurant', async () => {
    const d = await openDatabase({ memory: true });
    await d.migrate();
    const boot = await bootstrapOrganization(d.db, { orgName: 'Demo', branchName: 'B', branchCode: 'B', owner: { name: 'O', email: 'o@demo.local', password: 'x'.repeat(12) } });
    await d.db.transaction((tx) => seedDemoData(tx, boot.org.id, boot.branch.id, boot.owner.id));
    const menu = await loadBranchMenu(d.db, { orgId: boot.org.id, branchId: boot.branch.id, channel: 'DINE_IN', at: new Date('2026-10-12T05:00:00Z') });
    expect(menu.items.length).toBeGreaterThan(10);
    expect(menu.items.every((i) => i.available)).toBe(true);
    await d.close();
  });
});
