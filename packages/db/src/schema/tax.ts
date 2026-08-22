import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { studios, tenantColumns, users } from './base';
import { purchaseOrders } from './purchase-orders';
import { vendors } from './vendors';

/**
 * The tax-rule register. SOL-25 revision 24, section 5.
 *
 * One row is one immutable version of one rule. The composite key is
 * `(id, version)`: appending a version inserts a NEW row; an existing row is
 * never updated or deleted (the migration installs a trigger that rejects
 * UPDATE and DELETE).
 *
 * Two owner kinds share the table:
 * - `CENTRAL` — the verified register (PPN_STANDARD_2025). `studioId` is
 *   NULL and the row is seeded by the migration. Every studio reads it; no
 *   studio owns it.
 * - `STUDIO` — custom unverified rules. `studioId` is the owning studio.
 *
 * The RLS policy exposes CENTRAL rows to every studio and each studio's own
 * STUDIO rows only; the WITH CHECK clause lets a studio insert only its own
 * STUDIO rows, so no studio can forge a CENTRAL row through the API.
 *
 * The nested wire structures (verified evidence, exclusions, sources) are
 * stored verbatim as JSONB and emitted back verbatim, so the verified leaf
 * is copied byte-for-byte into every projection and snapshot.
 */
export const taxRules = pgTable(
  'tax_rules',
  {
    /** The stable rule id: `PPN_STANDARD_2025` or a studio custom rule uuid. */
    id: text('id').notNull(),
    /** The immutable version number, starting at 1. */
    version: integer('version').notNull(),
    /** NULL for CENTRAL rules; the owning studio for STUDIO rules. */
    studioId: uuid('studio_id').references(() => studios.id),
    /** CENTRAL | STUDIO. */
    ownerType: text('owner_type').notNull(),
    /** VERIFIED | CUSTOM_UNVERIFIED. */
    status: text('status').notNull(),
    /** Human label; CENTRAL rules carry none. */
    label: text('label'),
    /** Custom rule code; never PPN_STANDARD_2025 (CustomTaxRuleCode). */
    code: text('code').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    taxType: text('tax_type').notNull(),
    currency: text('currency').notNull(),
    /** RATIONAL_RATE | FIXED_AMOUNT. */
    calculationMode: text('calculation_mode').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    verifiedAt: date('verified_at'),
    /** Exact rational-rate text; NULL for FIXED_AMOUNT and CENTRAL-excluded paths. */
    statutoryRateNumerator: text('statutory_rate_numerator'),
    statutoryRateDenominator: text('statutory_rate_denominator'),
    dppFactorNumerator: text('dpp_factor_numerator'),
    dppFactorDenominator: text('dpp_factor_denominator'),
    /** The FIXED_AMOUNT tax per document, numeric(20,2). */
    fixedAmount: numeric('fixed_amount', { precision: 20, scale: 2 }),
    roundingMode: text('rounding_mode').notNull(),
    /** The rounding unit in minor units; 100 = whole rupiah. */
    roundingUnitMinor: integer('rounding_unit_minor').notNull(),
    roundDppBeforeTax: boolean('round_dpp_before_tax'),
    roundingStage: text('rounding_stage'),
    calculationScope: text('calculation_scope').notNull(),
    /** VerifiedTaxEvidence[] — the controlled register, byte-for-byte. */
    evidenceJson: jsonb('evidence_json'),
    /** VerifiedTaxExclusion[] — the approved exclusion register. */
    exclusionsJson: jsonb('exclusions_json'),
    /** TaxRuleSource[] — documentary sources of a custom rule. */
    sourcesJson: jsonb('sources_json'),
    applicabilityConfirmationText: text('applicability_confirmation_text'),
    disclaimerText: text('disclaimer_text').notNull(),
    entityVersion: uuid('entity_version').notNull().defaultRandom(),
    ...tenantColumns,
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })],
);

/**
 * The immutable tax snapshot. SOL-25 revision 24, section 4 (`TaxSnapshot`).
 *
 * One snapshot freezes the applied tax facts of one issued document. The
 * five closed modes are discriminated by `mode`:
 * VERIFIED_RATIONAL, CUSTOM_RATIONAL, CUSTOM_FIXED,
 * CUSTOM_RECORDING_IDR, CUSTOM_RECORDING_NON_IDR.
 *
 * The audit base (section 4 `TaxSnapshotAuditBase`) lives in columns so the
 * snapshot is queryable; the mode-specific wire body is stored verbatim in
 * `payload` (JSONB, money as canonical strings — never a float) and emitted
 * back without a projection pass. Rows are insert-only: the migration
 * installs a trigger that rejects UPDATE and DELETE.
 */
export const taxSnapshots = pgTable('tax_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  /** The wire `TaxSnapshotAuditBase.snapshotId` — equals the row id. */
  snapshotId: text('snapshot_id').notNull(),
  documentId: text('document_id').notNull(),
  /** QUOTATION | COMMERCIAL_INVOICE. */
  documentType: text('document_type').notNull(),
  documentVersion: text('document_version').notNull(),
  documentIssueDate: date('document_issue_date').notNull(),
  documentStatus: text('document_status').notNull(),
  taxType: text('tax_type').notNull().default('PPN'),
  jurisdiction: text('jurisdiction').notNull().default('ID'),
  includedLineIds: jsonb('included_line_ids').notNull(),
  excludedLineIds: jsonb('excluded_line_ids').notNull(),
  confirmedById: uuid('confirmed_by_id')
    .notNull()
    .references(() => users.id),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
  acceptedConfirmationText: text('accepted_confirmation_text').notNull(),
  /** One of the five closed snapshot modes. */
  mode: text('mode').notNull(),
  /** The complete mode-specific wire body (audit fields included). */
  payload: jsonb('payload').notNull(),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});

/**
 * The immutable supplier tax recording. SOL-25 revision 24, section 4
 * (`SupplierTaxRecording`).
 *
 * Records supplier-stated tax facts without calculation: dpp and tax amount
 * are recorded verbatim from the supplier document, in the document
 * currency. `exchangeRateEvidence` and `source` are stored verbatim; the
 * server never validates or normalizes an exchange rate. Insert-only, like
 * every tax fact: the migration trigger rejects UPDATE and DELETE.
 */
export const supplierTaxRecordings = pgTable('supplier_tax_recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id),
  purchaseOrderId: uuid('purchase_order_id')
    .notNull()
    .references(() => purchaseOrders.id),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => vendors.id),
  status: text('status').notNull().default('CUSTOM_UNVERIFIED'),
  supplierDocumentReference: text('supplier_document_reference').notNull(),
  label: text('label').notNull(),
  documentCurrency: text('document_currency').notNull(),
  dppAmount: numeric('dpp_amount', { precision: 20, scale: 2 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 20, scale: 2 }).notNull(),
  exchangeRateEvidence: jsonb('exchange_rate_evidence'),
  source: jsonb('source').notNull(),
  acceptedConfirmationText: text('accepted_confirmation_text').notNull(),
  recordedById: uuid('recorded_by_id')
    .notNull()
    .references(() => users.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  entityVersion: uuid('entity_version').notNull().defaultRandom(),
  ...tenantColumns,
});
