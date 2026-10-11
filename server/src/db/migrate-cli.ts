import { loadConfig } from '../config';
import { openDatabase } from './client';

const config = loadConfig();
const d = await openDatabase({ url: config.DATABASE_URL, dataDir: config.PGLITE_DIR });
await d.migrate();
console.log(`Migrations applied (${d.kind}).`);
await d.close();
