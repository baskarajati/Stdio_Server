import { sql } from 'drizzle-orm';
import { pgTable, numeric, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The tenant. Every other table carries `studioId` and is isolated by
 * Row-Level Security. The contract calls this object `company`
 * (`MeResponse.data.company`); the server maps `company` to this table.
 */
export const studios = pgTable('studios', {
  /** The tenant row carries the same physical `studio_id` key as every child table. */
  id: uuid('studio_id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** ISO 4217 code, e.g. `IDR`. `MeResponse.data.company.currency`. */
  currency: text('currency').notNull().default('IDR'),
  /** IANA zone, e.g. `Asia/Jakarta`. `MeResponse.data.company.timezone`. */
  timezone: text('timezone').notNull().default('Asia/Jakarta'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
});

/** A staff member of one studio. `MeResponse.data.user` defines the shape. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** One of OWNER, PM, DESIGNER, FINANCE, PROCUREMENT. */
    role: text('role').notNull(),
    /**
     * The person's hourly labour rate in the studio currency, as
     * `numeric(20,4)`. The client never sends or reads it (D-007); the
     * timesheet create snapshots it to `timesheet_entries.effective_hourly_rate`
     * for the budget-versus-actual report (SOL-19 section 2.6).
     */
    labourRate: numeric('labour_rate', { precision: 20, scale: 4 }),
    /** Bumps on every write. The server serialises it as the ETag. */
    entityVersion: uuid('entity_version').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('users_studio_email_idx').on(table.studioId, table.email),
    unique('users_studio_id_unq').on(table.studioId, table.id),
  ],
);

/** The shared timestamp columns every domain table carries. */
export const tenantColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
};
