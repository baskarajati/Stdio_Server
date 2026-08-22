import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';

/**
 * The guarded-write idempotency store. SOL-28 revision 7 defines the rule:
 *
 * - Scope: `(studioId, Idempotency-Key)` for 72 hours after completion (the
 *   durable offline retry period of the native client).
 * - Fingerprint: SHA-256 over method + normalized path + Content-Type + exact
 *   body bytes.
 * - Matching retry: the original status, body, content type and ETag return
 *   without another mutation.
 * - Same key, other fingerprint: `409 IDEMPOTENCY_KEY_REUSED`, never executed.
 *
 * `responseBody` stores the completed JSON body. A PROCESSING row holds the
 * lock while the first request runs; concurrent matching requests wait on the
 * advisory lock keyed by the row, then read the completed result. The
 * `created_at` index serves the non-completed expiry sweep.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: text('status').notNull().default('PROCESSING'),
    responseStatus: text('response_status'),
    /**
     * The exact completed response body bytes (written by `serializeJson`).
     * TEXT, not jsonb: a jsonb round-trip through the pg driver parses the
     * large decimal tokens as JavaScript floats and the replayed money loses
     * digits. TEXT replays the original bytes verbatim.
     */
    responseBody: text('response_body'),
    responseEtag: text('response_etag'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...tenantColumns,
  },
  (table) => [
    uniqueIndex('idempotency_keys_studio_key_idx').on(table.studioId, table.key),
    index('idempotency_keys_completed_idx').on(table.completedAt),
    index('idempotency_keys_created_idx').on(table.createdAt),
  ],
);
