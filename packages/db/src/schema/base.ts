import { sql } from 'drizzle-orm';
import { numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
     * The person's hourly rate in IDR (SOL-19). Never projected to a PM
     * (D-007): the timesheet entry snapshots it at create time and the
     * budget report uses the snapshot only. Null means no rate; labour
     * cost for that person is zero until a rate exists.
     */
    hourlyRate: numeric('hourly_rate', { precision: 20, scale: 4 }),
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
