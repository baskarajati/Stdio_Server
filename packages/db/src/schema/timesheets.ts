import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns, users } from './base';
import { projects } from './projects';

/**
 * Hours by a person, on a project, on a date. The contract does not define
 * this object yet (gap G1, in v1 scope per the SOL-14 Q12 decision). The
 * table carries the shape the mandate names; SOL-19 owns the contract change
 * and the endpoints.
 *
 * The cost of an entry for budget-versus-actual is derived by the report from
 * the person's rate and the hours, never stored as a float.
 */
export const timesheetEntries = pgTable('timesheet_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  /** The person who worked the hours. */
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  /** The day the work happened, in the studio's timezone. */
  entryDate: timestamp('entry_date', { withTimezone: true }).notNull(),
  /** Hours as a decimal string, e.g. `2.50`. Never a float. */
  hours: numeric('hours', { precision: 10, scale: 2 }).notNull(),
  /**
   * The labour rate snapshot (SOL-19 section 2.6): set at create time by
   * the server from the person's `users.hourly_rate`. Never on the wire
   * (D-007); the budget-versus-actual report reads it for the labour cost.
   */
  effectiveHourlyRate: numeric('effective_hourly_rate', { precision: 20, scale: 4 }),
  notes: text('notes'),
  status: text('status').notNull().default('LOGGED'),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});
