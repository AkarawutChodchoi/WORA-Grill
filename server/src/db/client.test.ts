import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDatabase } from './client';

describe('database', () => {
  it('applies all migrations to a fresh in-memory Postgres', async () => {
    const d = await openDatabase({ memory: true });
    await d.migrate();
    const r = await d.db.execute(sql`select count(*)::int as n from information_schema.tables where table_name in ('organizations','users','audit_logs')`);
    expect((r as any).rows[0].n).toBe(3);
    await d.migrate(); // idempotent
    await d.close();
  });
});
