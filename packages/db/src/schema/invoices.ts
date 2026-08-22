import { jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns, users } from './base';
import { clients } from './clients';
import { projectEngagements, projects } from './projects';

/**
 * A demand for payment. It can be partial and it links to a project.
 * Shape from `InvoiceSummary`, `InvoiceDetail` and `ProjectFinanceInvoice` in
 * `contracts/openapi/native-v1.yaml`.
 *
 * `paidAmount` and `outstandingAmount` are never stored: the server derives
 * them from the payment and receivable-component rows, so the numbers cannot
 * drift apart.
 */
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  invoiceNumber: text('invoice_number').notNull(),
  displayNumber: text('display_number'),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  projectId: uuid('project_id').references(() => projects.id),
  /** SOL-28: the engagement that owns this invoice. D-019: money belongs to the engagement. */
  engagementId: uuid('engagement_id').references(() => projectEngagements.id),
  /** Milestone billing reference; the milestones table lands in a later issue. */
  milestoneId: uuid('milestone_id'),
  /** Progress-certificate billing reference carried by the contract shape. */
  progressCertificateId: uuid('progress_certificate_id'),
  /** SOL-28: why this invoice may be billed. One of MILESTONE, PROGRESS_CERTIFICATE, MANUAL. */
  billingBasis: text('billing_basis'),
  status: text('status').notNull().default('DRAFT'),
  currency: text('currency').notNull().default('IDR'),
  issueDate: timestamp('issue_date', { withTimezone: true }),
  dueDate: timestamp('due_date', { withTimezone: true }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  totalAmount: numeric('total_amount', { precision: 20, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 20, scale: 2 }),
  /** SOL-20/SOL-25: NONE, CUSTOM_UNVERIFIED, or PPN_STANDARD_2025 (gated behind SOL-25). */
  taxMode: text('tax_mode').notNull().default('NONE'),
  /**
   * Immutable snapshot of the tax rule applied at draft time. Frozen on issue;
   * never edited afterwards (SOL-20 revision 1 audit contract).
   */
  taxRuleSnapshot: jsonb('tax_rule_snapshot'),
  /** User applicability confirmations recorded by the write actor (SOL-20 revision 1). */
  taxConfirmations: jsonb('tax_confirmations'),
  /** The rounded tax base in the invoice currency, when a verified rule computed it. */
  dppAmount: numeric('dpp_amount', { precision: 20, scale: 2 }),
  collectionStatus: text('collection_status').notNull().default('NONE'),
  collectionNote: text('collection_note'),
  collectionOwnerId: uuid('collection_owner_id').references(() => users.id),
  collectionReminderDate: text('collection_reminder_date'),
  /** SOL-28 audit fields: who drafted and who issued this invoice. */
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  issuedByUserId: uuid('issued_by_user_id').references(() => users.id),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});

/** One payment against an invoice. Shape from `InvoicePayment`. */
export const invoicePayments = pgTable('invoice_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id),
  amount: numeric('amount', { precision: 20, scale: 2 }).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
  method: text('method').notNull(),
  reference: text('reference'),
  ...tenantColumns,
});

/**
 * One receivable component of an invoice (deposit, retention, progress).
 * Shape from `InvoiceReceivableComponent` / `ProjectFinanceInvoice`
 * `receivableComponents`. Outstanding is derived: amount minus settled.
 */
export const invoiceReceivableComponents = pgTable('invoice_receivable_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id),
  kind: text('kind').notNull(),
  amount: numeric('amount', { precision: 20, scale: 2 }).notNull(),
  settledAmount: numeric('settled_amount', { precision: 20, scale: 2 }).notNull().default('0'),
  ...tenantColumns,
});
