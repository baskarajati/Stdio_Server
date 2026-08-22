import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';
import { clients } from './clients';
import { projectEngagements, projects } from './projects';

/**
 * A priced offer to a client. Shape from `QuotationSummary` and
 * `ProjectQuotation` in `contracts/openapi/native-v1.yaml`.
 *
 * A quotation has a `version`: a revision creates a new row with the same
 * `quotationNumber` and a higher `version`.
 */
export const quotations = pgTable('quotations', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  quotationNumber: text('quotation_number').notNull(),
  title: text('title').notNull(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  projectId: uuid('project_id').references(() => projects.id),
  engagementId: uuid('engagement_id').references(() => projectEngagements.id),
  version: numeric('version', { precision: 10, scale: 0 }).notNull().default('1'),
  status: text('status').notNull().default('DRAFT'),
  quotationType: text('quotation_type'),
  feeModel: text('fee_model'),
  /** ISO 4217 code of the quoted amounts. */
  currency: text('currency').notNull().default('IDR'),
  subtotalAmount: numeric('subtotal_amount', { precision: 20, scale: 2 }),
  discountPercent: numeric('discount_percent', { precision: 10, scale: 4 }),
  discountAmount: numeric('discount_amount', { precision: 20, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 20, scale: 2 }),
  totalAmount: numeric('total_amount', { precision: 20, scale: 2 }),
  defaultRatePerSqm: numeric('default_rate_per_sqm', { precision: 20, scale: 2 }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  quotationDate: timestamp('quotation_date', { withTimezone: true }),
  lastAcceptedAt: timestamp('last_accepted_at', { withTimezone: true }),
  lastDeclinedAt: timestamp('last_declined_at', { withTimezone: true }),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});

/**
 * One priced line of a quotation. The contract `ProjectQuotation.items` and
 * `ScheduleOfValuesLine` shapes merge here: a line carries a type, quantity,
 * unit rate and the derived totals. All money is `numeric(20,2)`.
 */
export const quotationItems = pgTable('quotation_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  quotationId: uuid('quotation_id')
    .notNull()
    .references(() => quotations.id),
  lineOrder: numeric('line_order', { precision: 10, scale: 0 }).notNull(),
  lineType: text('line_type').notNull().default('FEE'),
  code: text('code'),
  description: text('description').notNull(),
  unit: text('unit'),
  quantity: numeric('quantity', { precision: 20, scale: 4 }),
  unitRate: numeric('unit_rate', { precision: 20, scale: 2 }),
  lineSubtotal: numeric('line_subtotal', { precision: 20, scale: 2 }),
  lineTaxAmount: numeric('line_tax_amount', { precision: 20, scale: 2 }),
  lineTotal: numeric('line_total', { precision: 20, scale: 2 }),
  sourceType: text('source_type'),
  sourceId: uuid('source_id'),
  ...tenantColumns,
});

/**
 * One payment milestone of a quotation. Shape from
 * `ProjectQuotation.paymentMilestones` in the contract.
 */
export const quotationPaymentMilestones = pgTable('quotation_payment_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  quotationId: uuid('quotation_id')
    .notNull()
    .references(() => quotations.id),
  sortOrder: numeric('sort_order', { precision: 10, scale: 0 }).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  dueTrigger: text('due_trigger'),
  percentage: numeric('percentage', { precision: 10, scale: 4 }),
  amount: numeric('amount', { precision: 20, scale: 2 }),
  ...tenantColumns,
});
