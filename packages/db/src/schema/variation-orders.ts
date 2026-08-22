import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { studios, tenantColumns } from './base';
import { projectChanges } from './project-changes';
import { projectEngagements, projects } from './projects';

/**
 * A change to the scope after the quote is signed. Studios lose money here,
 * so the variation order is a first-class object, not a line on a project.
 *
 * Shape from `VariationOrder` and `VariationOrderApprovalRequest` in
 * `contracts/openapi/native-v1.yaml`. The object stores the before/after
 * snapshot and the two effects. Every money column is `numeric(20,2)`.
 */
export const variationOrders = pgTable('variation_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  /** SOL-28/D-019: every variation order belongs to exactly one engagement. */
  engagementId: uuid('engagement_id')
    .notNull()
    .references(() => projectEngagements.id),
  /** The display number, e.g. `VO-0001`. */
  displayNumber: text('display_number'),
  /** The stable system number. */
  systemNumber: text('system_number'),
  /** One of ISSUED, SUPERSEDED, VOIDED. */
  status: text('status').notNull().default('ISSUED'),
  currency: text('currency').notNull().default('IDR'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  effectiveDate: timestamp('effective_date', { withTimezone: true }).notNull(),
  /** The contract revision this variation amends. */
  contractRevisionId: uuid('contract_revision_id'),
  /** The schedule of values this variation produces. */
  scheduleOfValuesId: uuid('schedule_of_values_id'),
  /**
   * SOL-28 requirement 2: the project change this variation was minted from.
   * The approve-and-issue write sets it; a legacy row has none.
   */
  projectChangeId: uuid('project_change_id').references(() => projectChanges.id),
  beforeFeeAmount: numeric('before_fee_amount', { precision: 20, scale: 2 }),
  afterFeeAmount: numeric('after_fee_amount', { precision: 20, scale: 2 }),
  feeEffect: numeric('fee_effect', { precision: 20, scale: 2 }).notNull(),
  beforeBoqAmount: numeric('before_boq_amount', { precision: 20, scale: 2 }),
  afterBoqAmount: numeric('after_boq_amount', { precision: 20, scale: 2 }),
  boqEffect: numeric('boq_effect', { precision: 20, scale: 2 }).notNull(),
  beforeContractValue: numeric('before_contract_value', { precision: 20, scale: 2 }),
  afterContractValue: numeric('after_contract_value', { precision: 20, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 20, scale: 2 }),
  totalAmount: numeric('total_amount', { precision: 20, scale: 2 }),
  timeEffectDays: numeric('time_effect_days', { precision: 10, scale: 0 }),
  beforeCompletionDate: timestamp('before_completion_date', { withTimezone: true }),
  afterCompletionDate: timestamp('after_completion_date', { withTimezone: true }),
  adoptedAt: timestamp('adopted_at', { withTimezone: true }),
  adoptedById: uuid('adopted_by_id'),
  adoptionAttestationReference: text('adoption_attestation_reference'),
  adoptionEvidenceInterpretation: text('adoption_evidence_interpretation'),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});

/** One approval decision on a variation order. Shape from `VariationOrderApproval`. */
export const variationOrderApprovals = pgTable('variation_order_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  variationOrderId: uuid('variation_order_id')
    .notNull()
    .references(() => variationOrders.id),
  sequence: numeric('sequence', { precision: 10, scale: 0 }).notNull(),
  approverId: uuid('approver_id'),
  approverName: text('approver_name').notNull(),
  approverRole: text('approver_role').notNull(),
  /** One of APPROVED, REJECTED. */
  decision: text('decision').notNull(),
  decisionNotes: text('decision_notes'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  ...tenantColumns,
});
