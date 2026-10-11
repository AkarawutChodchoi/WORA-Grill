import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts } from './_common';
import { branches, organizations, users } from './core';

export const DEVICE_KINDS = ['POS', 'WAITER', 'KDS', 'KIOSK', 'PRINTER', 'CUSTOMER_DISPLAY', 'EDC', 'CASH_DRAWER'] as const;

/**
 * Registered devices. Terminal devices (POS/WAITER/KDS/KIOSK) are "paired" by a manager and hold a
 * long-lived device cookie whose hash is `token_hash`; staff then sign in on them with a PIN.
 */
export const devices = pgTable(
  'devices',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').notNull().references(() => branches.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: DEVICE_KINDS }).notNull(),
    tokenHash: text('token_hash'),
    stationId: uuid('station_id'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: ts('last_seen_at'),
    createdBy: uuid('created_by').references(() => users.id),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('devices_token_uq').on(t.tokenHash), index('devices_branch_idx').on(t.branchId)],
);
