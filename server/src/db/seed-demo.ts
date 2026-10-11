import type { DbOrTx } from './client';

/**
 * Demo master data (menu, tables, ingredients…). Each module adds to this as it is built.
 * Everything here is labelled DEMO and only runs on an empty database.
 */
export async function seedDemoData(_db: DbOrTx, _orgId: string, _branchId: string, _ownerId: string): Promise<void> {}
