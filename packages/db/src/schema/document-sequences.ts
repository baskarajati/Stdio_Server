import { sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { studios } from './base';

/**
 * One atomic per-studio counter per document type (SOL-131; SOL-137
 * conditions C2 and C5).
 *
 * The variation-order mint hands out `VO-%04d` from this table. Invoices
 * (`INV`) and quotations (`QUO`) get their own namespace rows later. One
 * namespace never shares sequence with another type, so numbers stay stable
 * and readable inside one studio (C5).
 *
 * Gap and overflow semantics (C6): the counter only moves on COMMIT, so a
 * rolled-back write never consumes a number. Numbers are monotonic; a gap
 * can only come from an aborted transaction that retried and succeeded —
 * expected, never a violation. VOIDED/SUPERSEDED documents keep their
 * numbers; a number is never reused. Formatting (`VO-%04d`) expands past
 * 9999 (`VO-10000`).
 */
export const studioNumberSequences = pgTable(
  'studio_number_sequences',
  {
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id),
    /** The document-type namespace: `VO`, then `INV`, `QUO` per type. */
    namespace: text('namespace').notNull(),
    /** The next number to hand out. Formatting is presentation (C2). */
    nextValue: integer('next_value').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.studioId, table.namespace] })],
);
