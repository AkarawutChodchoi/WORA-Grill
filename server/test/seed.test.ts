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

describe('WORA Grill sample menu', () => {
  it('imports the 50 dishes with photos and options, and is safe to re-run', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { seedWoraMenu } = await import('../src/db/seed-wora');
    const uploadDir = mkdtempSync(path.join(tmpdir(), 'wora-'));
    const d = await openDatabase({ memory: true });
    await d.migrate();
    const boot = await bootstrapOrganization(d.db, { orgName: 'WORA', branchName: 'B', branchCode: 'B', owner: { name: 'O', email: 'o@demo.local', password: 'x'.repeat(12) } });

    const first = await d.db.transaction((tx) => seedWoraMenu(tx, boot.org.id, boot.branch.id, uploadDir));
    expect(first).toEqual({ created: 50, skipped: 0 });
    const menu = await loadBranchMenu(d.db, { orgId: boot.org.id, branchId: boot.branch.id, channel: 'DINE_IN', at: new Date('2026-10-12T05:00:00Z') });
    expect(menu.items).toHaveLength(50);
    expect(menu.categories.map((c) => c.name)).toContain('ก๋วยเตี๋ยว');
    const tomYum = menu.items.find((i) => i.sku === 'S01')!;
    expect(tomYum.priceSatang).toBe(18000);
    expect(tomYum.imageUrl).toMatch(/^\/uploads\/menu\/.+\.jpg$/);
    expect(existsSync(path.join(uploadDir, tomYum.imageUrl!.replace('/uploads/', '')))).toBe(true);
    const spice = tomYum.modifierGroups.find((g) => g.name === 'ระดับความเผ็ด')!;
    expect(spice).toMatchObject({ minSelect: 1, maxSelect: 1 });
    expect(spice.modifiers.map((m) => m.name)).toEqual(['ไม่เผ็ด', 'เผ็ดน้อย', 'เผ็ดกลาง', 'เผ็ดมาก']);
    const massaman = menu.items.find((i) => i.sku === 'S04')!;
    expect(massaman.modifierGroups.find((g) => g.name === 'เลือกเนื้อสัตว์')!.modifiers.find((m) => m.name === 'ไก่')!.priceDeltaSatang).toBe(-3000);

    const again = await d.db.transaction((tx) => seedWoraMenu(tx, boot.org.id, boot.branch.id, uploadDir));
    expect(again).toEqual({ created: 0, skipped: 50 });
    await d.close();
  });
});
