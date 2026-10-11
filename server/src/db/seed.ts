/**
 * Development seed: creates the WORA Grill sample restaurant (50-dish menu with photos, 12 tables).
 * Never run against production data.
 * Credentials come from env (SEED_OWNER_PASSWORD, SEED_STAFF_PIN) or are randomly generated and printed once.
 */
import { randomInt } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { loadConfig } from '../config';
import { hashSecret, randomToken } from '../lib/crypto';
import { bootstrapOrganization } from '../modules/auth/bootstrap';
import { openDatabase } from './client';
import { branches, organizations, userRoles, users } from './schema';
import { seedTables } from './seed-demo';
import { seedWoraMenu } from './seed-wora';

const config = loadConfig();
if (config.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error('Refusing to seed demo data in production (set ALLOW_DEMO_SEED=true to override).');
  process.exit(1);
}
const d = await openDatabase({ url: config.DATABASE_URL, dataDir: config.PGLITE_DIR });
await d.migrate();
const db = d.db;

const [{ n }] = await db.select({ n: count() }).from(organizations);
if (n > 0) {
  console.log('Database already has an organisation — seed skipped (it only runs on an empty database).');
  await d.close();
  process.exit(0);
}

const ownerEmail = process.env.SEED_OWNER_EMAIL ?? 'owner@demo.local';
const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? randomToken(12);
const pin = () => process.env.SEED_STAFF_PIN ?? String(randomInt(1000, 9999)).padStart(4, '0');

const credentials: { role: string; name: string; email?: string; password?: string; pin: string }[] = [];
await db.transaction(async (tx) => {
  const ownerPin = pin();
  const boot = await bootstrapOrganization(tx, {
    orgName: 'WORA Grill',
    branchName: 'WORA Grill สาขาหลัก',
    branchCode: 'HQ',
    owner: { name: 'เจ้าของร้าน', email: ownerEmail, password: ownerPassword, pin: ownerPin },
  });
  credentials.push({ role: 'OWNER', name: 'เจ้าของร้าน', email: ownerEmail, password: ownerPassword, pin: ownerPin });
  const staff = [
    ['MANAGER', 'ผู้จัดการ สมหญิง'],
    ['CASHIER', 'แคชเชียร์ มานี'],
    ['WAITER', 'เสิร์ฟ ปิติ'],
    ['WAITER', 'เสิร์ฟ ชูใจ'],
    ['KITCHEN', 'ครัว วีระ'],
    ['STOREKEEPER', 'สโตร์ สมศักดิ์'],
  ] as const;
  for (const [role, name] of staff) {
    const p = pin();
    const email = role === 'MANAGER' ? 'manager@demo.local' : undefined;
    const password = email ? randomToken(12) : undefined;
    const [u] = await tx
      .insert(users)
      .values({ organizationId: boot.org.id, name, email: email ?? null, passwordHash: password ? await hashSecret(password) : null, pinHash: await hashSecret(p) })
      .returning();
    await tx.insert(userRoles).values({ userId: u.id, roleId: boot.roleIds[role], branchId: boot.branch.id });
    credentials.push({ role, name, email, password, pin: p });
  }
  await tx
    .update(branches)
    .set({ address: 'ที่อยู่ตัวอย่าง (แก้ได้ที่ ตั้งค่าร้าน)', phone: '02-000-0000', settings: { enabledPaymentMethods: ['CASH', 'CARD', 'TRANSFER'], receiptHeader: 'WORA Grill' } as never })
    .where(eq(branches.id, boot.branch.id));
  await seedWoraMenu(tx, boot.org.id, boot.branch.id, config.UPLOAD_DIR);
  await seedTables(tx, boot.org.id, boot.branch.id);
});

console.log('\nWORA Grill sample restaurant created. Store these credentials safely — they are not shown again:\n');
console.table(credentials);
await d.close();
