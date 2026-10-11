/**
 * Backup / restore for the embedded PGlite database.
 *   npm run db:backup                 → data/backups/rms-<timestamp>.tar.gz
 *   npm run db:restore -- <file>      → restores into PGLITE_DIR (refuses if the directory is not empty)
 * For a real PostgreSQL (DATABASE_URL set) use pg_dump / pg_restore — see docs/operations.md.
 * Stop the API server before restoring.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../config';

const config = loadConfig();
const [cmd, file] = process.argv.slice(2);

if (config.DATABASE_URL) {
  console.error('DATABASE_URL is set: use pg_dump/pg_restore for PostgreSQL (see docs/operations.md).');
  process.exit(1);
}

if (cmd === 'backup') {
  if (!existsSync(config.PGLITE_DIR)) {
    console.error(`No database at ${config.PGLITE_DIR}`);
    process.exit(1);
  }
  const db = new PGlite(config.PGLITE_DIR);
  await db.waitReady;
  const dump = await db.dumpDataDir('gzip');
  await db.close();
  const dir = path.resolve('data/backups');
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `rms-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  await writeFile(out, Buffer.from(await dump.arrayBuffer()));
  console.log(`Backup written: ${out}`);
} else if (cmd === 'restore') {
  if (!file || !existsSync(file)) {
    console.error('Usage: npm run db:restore -- <backup.tar.gz>');
    process.exit(1);
  }
  if (existsSync(config.PGLITE_DIR) && readdirSync(config.PGLITE_DIR).length > 0) {
    console.error(`${config.PGLITE_DIR} is not empty. Move it aside first (never overwrite live data).`);
    process.exit(1);
  }
  const blob = new Blob([await readFile(file)]);
  const db = new PGlite(config.PGLITE_DIR, { loadDataDir: blob });
  await db.waitReady;
  const r = await db.query<{ n: number }>('select count(*)::int as n from organizations');
  await db.close();
  console.log(`Restored into ${config.PGLITE_DIR} (${r.rows[0].n} organisation(s)).`);
} else {
  console.error('Usage: backup | restore <file>');
  process.exit(1);
}
