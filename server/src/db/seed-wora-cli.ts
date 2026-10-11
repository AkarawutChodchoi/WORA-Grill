/**
 * Adds the WORA Grill sample menu (50 dishes + photos) to an existing database without touching
 * anything else: dishes whose SKU already exists are skipped. Usage: npm run db:seed:wora
 */
import { asc, eq } from 'drizzle-orm';
import { loadConfig } from '../config';
import { openDatabase } from './client';
import { branches, organizations } from './schema';
import { seedWoraMenu } from './seed-wora';

const config = loadConfig();
const d = await openDatabase({ url: config.DATABASE_URL, dataDir: config.PGLITE_DIR });
await d.migrate();
const [org] = await d.db.select().from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
if (!org) {
  console.error('No organisation yet — run "npm run db:seed" (sample restaurant) or open the app to create one first.');
  await d.close();
  process.exit(1);
}
const [branch] = await d.db.select().from(branches).where(eq(branches.organizationId, org.id)).orderBy(asc(branches.createdAt)).limit(1);
const r = await d.db.transaction((tx) => seedWoraMenu(tx, org.id, branch.id, config.UPLOAD_DIR));
console.log(`WORA Grill menu: added ${r.created} dishes, skipped ${r.skipped} that already exist (organisation "${org.name}").`);
await d.close();
