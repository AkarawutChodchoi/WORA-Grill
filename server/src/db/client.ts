import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Schema = typeof schema;
export type DB = PgDatabase<any, Schema>;
export type Tx = PgTransaction<any, Schema, any>;
export type DbOrTx = DB | Tx;

export interface Database {
  db: DB;
  kind: 'pglite' | 'postgres';
  close: () => Promise<void>;
  migrate: () => Promise<void>;
}

function migrationsFolder(): string {
  // Works for `tsx server/src/...` (../../drizzle) and for the bundled dist/server/index.js (./drizzle).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../drizzle'), path.resolve(here, 'drizzle'), path.resolve('server/drizzle')];
  return candidates.find((p) => existsSync(path.join(p, 'meta', '_journal.json'))) ?? candidates[2];
}

/**
 * Open the database. `DATABASE_URL` → node-postgres pool; otherwise PGlite (embedded Postgres).
 * Pass `memory: true` for an isolated in-memory database (tests).
 */
export async function openDatabase(opts: { url?: string; dataDir?: string; memory?: boolean }): Promise<Database> {
  const folder = migrationsFolder();
  if (opts.url) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: opts.url, max: 10 });
    const db = drizzle(pool, { schema }) as unknown as DB;
    return { db, kind: 'postgres', close: () => pool.end(), migrate: () => migrate(db as any, { migrationsFolder: folder }) };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let client;
  if (opts.memory) client = new PGlite();
  else {
    const dir = opts.dataDir ?? './data/pglite';
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as DB;
  return { db, kind: 'pglite', close: () => client.close(), migrate: () => migrate(db as any, { migrationsFolder: folder }) };
}
