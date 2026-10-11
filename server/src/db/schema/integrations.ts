import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts } from './_common';
import { branches, organizations, users } from './core';

/** In-app notifications (bell). `userId` null = everyone in the branch with the required permission. */
export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    branchId: uuid('branch_id').references(() => branches.id),
    userId: uuid('user_id').references(() => users.id),
    /** Permission a user needs to see a broadcast notification. */
    requiredPermission: text('required_permission'),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_branch_created_idx').on(t.branchId, t.createdAt)],
);

export const notificationReads = pgTable(
  'notification_reads',
  {
    notificationId: uuid('notification_id').notNull().references(() => notifications.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    readAt: ts('read_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_reads_uq').on(t.notificationId, t.userId)],
);

/** Every inbound webhook, for idempotency (provider + event id) and troubleshooting. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: pk(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type'),
    status: text('status', { enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'] }).notNull().default('RECEIVED'),
    error: text('error'),
    /** Redacted summary only — never raw card data or secrets. */
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    receivedAt: createdAt(),
    processedAt: ts('processed_at'),
  },
  (t) => [uniqueIndex('webhook_events_uq').on(t.provider, t.eventId)],
);
