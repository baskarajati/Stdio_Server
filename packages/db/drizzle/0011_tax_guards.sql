-- SOL-101: close the tax persistence layer.
--
-- 1. FORCE row-level security on the three tax tables, matching SOL-23
--    (0001_yielding_jane_foster.sql). Migration 0010 enabled RLS but left
--    the tables owned by `stdio`, so the owner bypassed the policies.
--    FORCE makes every access go through the studio_isolation policy; a
--    forgotten role switch fails closed.
-- 2. Contract enums pinned as CHECK constraints, matching the SOL-23
--    pattern. The contract wins every argument; a value outside these sets
--    is a bug, and the database says so.
-- 3. Register indexes, matching the SOL-23 register-query pattern: every
--    list starts at studio_id.

ALTER TABLE "tax_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- tax_rules: the rule register. The launch surface is the Indonesian PPN
-- preset; every leaf in revision 24 pins these values.
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_owner_type_check
  CHECK ("owner_type" IN ('CENTRAL', 'STUDIO'));--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_owner_status_pair_check
  CHECK (("owner_type" = 'CENTRAL' AND "status" = 'VERIFIED')
      OR ("owner_type" = 'STUDIO' AND "status" = 'CUSTOM_UNVERIFIED'));--> statement-breakpoint
-- A custom rule can never reuse a central preset code. PPN_STANDARD_2025 is
-- the only central code today; a future central preset extends this list in
-- its own migration. The API returns 422 TAX_RULE_CODE_RESERVED before this
-- check; the database is the second net.
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_custom_code_reserved_check
  CHECK ("owner_type" = 'CENTRAL' OR "code" <> 'PPN_STANDARD_2025');--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_jurisdiction_check
  CHECK ("jurisdiction" = 'ID');--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_tax_type_check
  CHECK ("tax_type" = 'PPN');--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_currency_check
  CHECK ("currency" = 'IDR');--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_calculation_mode_check
  CHECK ("calculation_mode" IN ('RATIONAL_RATE', 'FIXED_AMOUNT'));--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_rounding_mode_check
  CHECK ("rounding_mode" = 'HALF_UP');--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_rounding_unit_check
  CHECK ("rounding_unit_minor" = 100);--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_calculation_scope_check
  CHECK ("calculation_scope" = 'DOCUMENT_TAX_BUCKET');--> statement-breakpoint
-- The rational leaf carries both rate fields and DPP factors and a rounding
-- stage; the fixed leaf carries none of them. A half-filled rule is a
-- calculation bug and the database says so.
ALTER TABLE "tax_rules" ADD CONSTRAINT tax_rules_leaf_shape_check
  CHECK (("calculation_mode" = 'RATIONAL_RATE'
          AND "statutory_rate_numerator" IS NOT NULL
          AND "statutory_rate_denominator" IS NOT NULL
          AND "dpp_factor_numerator" IS NOT NULL
          AND "dpp_factor_denominator" IS NOT NULL
          AND "fixed_amount" IS NULL
          AND "round_dpp_before_tax" IS TRUE
          AND "rounding_stage" = 'DPP_THEN_PPN')
      OR ("calculation_mode" = 'FIXED_AMOUNT'
          AND "statutory_rate_numerator" IS NULL
          AND "statutory_rate_denominator" IS NULL
          AND "dpp_factor_numerator" IS NULL
          AND "dpp_factor_denominator" IS NULL
          AND "fixed_amount" IS NOT NULL
          AND "round_dpp_before_tax" IS NULL
          AND "rounding_stage" IS NULL));--> statement-breakpoint

-- tax_snapshots: the five closed leaves of TaxSnapshot.
ALTER TABLE "tax_snapshots" ADD CONSTRAINT tax_snapshots_mode_check
  CHECK ("mode" IN ('VERIFIED_RATIONAL', 'CUSTOM_RATIONAL', 'CUSTOM_FIXED',
                    'CUSTOM_RECORDING_IDR', 'CUSTOM_RECORDING_NON_IDR'));--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT tax_snapshots_document_type_check
  CHECK ("document_type" IN ('QUOTATION', 'COMMERCIAL_INVOICE'));--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT tax_snapshots_tax_type_check
  CHECK ("tax_type" = 'PPN');--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT tax_snapshots_jurisdiction_check
  CHECK ("jurisdiction" = 'ID');--> statement-breakpoint

-- supplier_tax_recordings: the IDR leaf carries no exchange-rate evidence;
-- the non-IDR leaf requires it. A recording never mixes the two.
ALTER TABLE "supplier_tax_recordings" ADD CONSTRAINT supplier_tax_recordings_status_check
  CHECK ("status" = 'CUSTOM_UNVERIFIED');--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" ADD CONSTRAINT supplier_tax_recordings_currency_format_check
  CHECK ("document_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" ADD CONSTRAINT supplier_tax_recordings_currency_evidence_check
  CHECK (("document_currency" = 'IDR' AND "exchange_rate_evidence" IS NULL)
      OR ("document_currency" <> 'IDR' AND "exchange_rate_evidence" IS NOT NULL));--> statement-breakpoint

-- Register indexes. Every studio list starts at studio_id; snapshots and
-- recordings are looked up by their document and purchase order.
CREATE INDEX tax_rules_owner_idx ON "tax_rules" ("owner_type", "id", "version");--> statement-breakpoint
CREATE INDEX tax_rules_studio_idx ON "tax_rules" ("studio_id", "updated_at");--> statement-breakpoint
CREATE INDEX tax_snapshots_studio_idx ON "tax_snapshots" ("studio_id", "updated_at");--> statement-breakpoint
CREATE INDEX tax_snapshots_document_idx ON "tax_snapshots" ("document_id");--> statement-breakpoint
CREATE INDEX supplier_tax_recordings_studio_idx
  ON "supplier_tax_recordings" ("studio_id", "updated_at");--> statement-breakpoint
CREATE INDEX supplier_tax_recordings_po_idx
  ON "supplier_tax_recordings" ("purchase_order_id");
