import { numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns, users } from './base';
import { clients } from './clients';

/**
 * One job for one client. Shape from `ProjectSummary` and
 * `ProjectCreateRequest` in `contracts/openapi/native-v1.yaml`.
 *
 * `blueprintId` is a plain nullable uuid: the blueprint register is a later
 * endpoint, so no foreign key exists yet.
 */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  projectCode: text('project_code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  siteAddress: text('site_address'),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  status: text('status').notNull().default('ACTIVE'),
  projectType: text('project_type').notNull().default('INTERIOR'),
  serviceModel: text('service_model'),
  /** `manager` is a `Person` reference. */
  managerId: uuid('manager_id').references(() => users.id),
  blueprintId: uuid('blueprint_id'),
  /** The money rule: `numeric(20,2)`, never float. */
  budgetAmount: numeric('budget_amount', { precision: 20, scale: 2 }),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
}, (table) => [
  /** Referenced by child tables through tenant-matching foreign keys. */
  unique('projects_studio_id_unq').on(table.studioId, table.id),
]);

/**
 * One engagement on a project. Shape from `ProjectEngagement` in the
 * contract. Label fields are derived by the server.
 */
export const projectEngagements = pgTable('project_engagements', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  kind: text('kind').notNull(),
  sortOrder: numeric('sort_order', { precision: 10, scale: 0 }).notNull().default('0'),
  lifecycleStatus: text('lifecycle_status').notNull().default('ACTIVE'),
  contractState: text('contract_state').notNull().default('NONE'),
  /**
   * SOL-28/D-019: the engagement's own contract value. The project-level
   * contract value is a roll-up of these, never stored on the project.
   * `numeric(20,2)` per the money rule.
   */
  contractValue: numeric('contract_value', { precision: 20, scale: 2 }),
  /** ISO 4217 code of the engagement's contract amounts. */
  currency: text('currency').notNull().default('IDR'),
  /**
   * D-033 transaction price. Derived and stored so an approved variation
   * order changes it and an unapproved one does not. Server recomputes on
   * every variation-order write.
   */
  transactionPrice: numeric('transaction_price', { precision: 20, scale: 2 }),
  currentPhaseKey: text('current_phase_key'),
  phaseCount: numeric('phase_count', { precision: 10, scale: 0 }).notNull().default('0'),
  completedPhaseCount: numeric('completed_phase_count', { precision: 10, scale: 0 })
    .notNull()
    .default('0'),
  gatedByEngagementId: uuid('gated_by_engagement_id'),
  isGateSatisfied: text('is_gate_satisfied'),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});
