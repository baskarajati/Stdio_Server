CREATE TABLE "supplier_tax_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'CUSTOM_UNVERIFIED' NOT NULL,
	"supplier_document_reference" text NOT NULL,
	"label" text NOT NULL,
	"document_currency" text NOT NULL,
	"dpp_amount" numeric(20, 2) NOT NULL,
	"tax_amount" numeric(20, 2) NOT NULL,
	"exchange_rate_evidence" jsonb,
	"source" jsonb NOT NULL,
	"accepted_confirmation_text" text NOT NULL,
	"recorded_by_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rules" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"studio_id" uuid,
	"owner_type" text NOT NULL,
	"status" text NOT NULL,
	"label" text,
	"code" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_type" text NOT NULL,
	"currency" text NOT NULL,
	"calculation_mode" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"verified_at" date,
	"statutory_rate_numerator" text,
	"statutory_rate_denominator" text,
	"dpp_factor_numerator" text,
	"dpp_factor_denominator" text,
	"fixed_amount" numeric(20, 2),
	"rounding_mode" text NOT NULL,
	"rounding_unit_minor" integer NOT NULL,
	"round_dpp_before_tax" boolean,
	"rounding_stage" text,
	"calculation_scope" text NOT NULL,
	"evidence_json" jsonb,
	"exclusions_json" jsonb,
	"sources_json" jsonb,
	"applicability_confirmation_text" text,
	"disclaimer_text" text NOT NULL,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rules_id_version_pk" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "tax_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"snapshot_id" text NOT NULL,
	"document_id" text NOT NULL,
	"document_type" text NOT NULL,
	"document_version" text NOT NULL,
	"document_issue_date" date NOT NULL,
	"document_status" text NOT NULL,
	"tax_type" text DEFAULT 'PPN' NOT NULL,
	"jurisdiction" text DEFAULT 'ID' NOT NULL,
	"included_line_ids" jsonb NOT NULL,
	"excluded_line_ids" jsonb NOT NULL,
	"confirmed_by_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"accepted_confirmation_text" text NOT NULL,
	"mode" text NOT NULL,
	"payload" jsonb NOT NULL,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" ADD CONSTRAINT "supplier_tax_recordings_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" ADD CONSTRAINT "supplier_tax_recordings_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" ADD CONSTRAINT "supplier_tax_recordings_supplier_id_vendors_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" ADD CONSTRAINT "supplier_tax_recordings_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshots_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshots_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- SOL-25 revision 24: tenant isolation for the tax register. The CENTRAL
-- register (owner_type = 'CENTRAL', studio_id NULL) is visible to every
-- studio; a studio sees only its own STUDIO rows. The WITH CHECK clause lets
-- the application insert only its own STUDIO rows, so a tenant can never
-- forge a CENTRAL rule or another studio's rule through the API.
ALTER TABLE "tax_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY studio_isolation ON "tax_rules"
  USING ("owner_type" = 'CENTRAL' OR "studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("owner_type" = 'STUDIO' AND "studio_id" = current_setting('app.studio_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "tax_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY studio_isolation ON "tax_snapshots"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "supplier_tax_recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY studio_isolation ON "supplier_tax_recordings"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);--> statement-breakpoint
-- SOL-25 revision 24: tax facts are immutable. A rule version, a snapshot,
-- and a supplier recording are insert-only; UPDATE and DELETE fail closed.
-- A changed verified rule is a NEW version row, never an edit.
CREATE OR REPLACE FUNCTION forbid_tax_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tax rows are immutable: insert a new row, never update or delete';
END
$$;--> statement-breakpoint
CREATE TRIGGER tax_rules_immutable BEFORE UPDATE OR DELETE ON "tax_rules"
  FOR EACH ROW EXECUTE FUNCTION forbid_tax_row_mutation();--> statement-breakpoint
CREATE TRIGGER tax_snapshots_immutable BEFORE UPDATE OR DELETE ON "tax_snapshots"
  FOR EACH ROW EXECUTE FUNCTION forbid_tax_row_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_tax_recordings_immutable BEFORE UPDATE OR DELETE ON "supplier_tax_recordings"
  FOR EACH ROW EXECUTE FUNCTION forbid_tax_row_mutation();--> statement-breakpoint
-- SOL-25 revision 24, section 5: the centrally owned verified register,
-- seeded byte-for-byte from packages/core/src/tax/ppn-2025.ts. A test pins
-- the database row to the core preset so the two copies cannot drift.
INSERT INTO "tax_rules" (
  "id", "version", "studio_id", "owner_type", "status", "code", "jurisdiction",
  "tax_type", "currency", "calculation_mode", "effective_from", "effective_to",
  "verified_at", "statutory_rate_numerator", "statutory_rate_denominator",
  "dpp_factor_numerator", "dpp_factor_denominator", "fixed_amount",
  "rounding_mode", "rounding_unit_minor", "round_dpp_before_tax",
  "rounding_stage", "calculation_scope", "evidence_json", "exclusions_json",
  "applicability_confirmation_text", "disclaimer_text"
) VALUES (
  'PPN_STANDARD_2025', 1, NULL, 'CENTRAL', 'VERIFIED', 'PPN_STANDARD_2025', 'ID',
  'PPN', 'IDR', 'RATIONAL_RATE', '2025-01-01', NULL, '2026-08-21',
  '12', '100', '11', '12', NULL, 'HALF_UP', 100, true, 'DPP_THEN_PPN',
  'DOCUMENT_TAX_BUCKET',
  '[
    {"evidenceId":"UU-7-2021-HPP","authority":"DJP_RI","documentIdentifier":"UU 7/2021","title":"Undang-Undang Nomor 7 Tahun 2021 tentang Harmonisasi Peraturan Perpajakan","url":"https://jdih.kemenkeu.go.id/api/download/A9FAAB97-ACA7-4F87-9FDC-FAA8123D1454/7TAHUN2021UU.pdf","publishedAt":"2021-10-29","retrievedAt":"2026-08-22T21:10:00.000Z"},
    {"evidenceId":"PMK-131-2024-ART3","authority":"DJP_RI","documentIdentifier":"PMK-131/PMK.010/2024","title":"Peraturan Menteri Keuangan Nomor 131 Tahun 2024 tentang Perlakuan Pajak Pertambahan Nilai atas Impor Barang Kena Pajak, Penyerahan Barang Kena Pajak, Penyerahan Jasa Kena Pajak, Pemanfaatan Barang Kena Pajak Tidak Berwujud dari Luar Daerah Pabean di Dalam Daerah Pabean, dan Pemanfaatan Jasa Kena Pajak dari Luar Daerah Pabean di Dalam Daerah Pabean","url":"https://jdih.kemenkeu.go.id/api/download/F128868E-3CF6-4596-8407-C34EECA0E7BE/2024pmkeuangan131.pdf","publishedAt":"2024-12-31","retrievedAt":"2026-08-22T21:10:00.000Z"},
    {"evidenceId":"PMK-131-2024-JDIH","authority":"KEMENKEU_RI","documentIdentifier":"PMK-131-TAHUN-2024","title":"Peraturan Menteri Keuangan Nomor 131 Tahun 2024 tentang Perlakuan Pajak Pertambahan Nilai atas Impor Barang Kena Pajak, Penyerahan Barang Kena Pajak, Penyerahan Jasa Kena Pajak, Pemanfaatan Barang Kena Pajak Tidak Berwujud dari Luar Daerah Pabean di Dalam Daerah Pabean, dan Pemanfaatan Jasa Kena Pajak dari Luar Daerah Pabean di Dalam Daerah Pabean","url":"https://jdih.kemenkeu.go.id/api/download/F128868E-3CF6-4596-8407-C34EECA0E7BE/2024pmkeuangan131.pdf","publishedAt":"2024-12-31","retrievedAt":"2026-08-22T21:10:00.000Z"},
    {"evidenceId":"PER-11-PJ-2025-ART129","authority":"DJP_RI","documentIdentifier":"PER-11/PJ/2025","title":"PER-11/PJ/2025 — Ketentuan Pelaporan Pajak Penghasilan, Pajak Pertambahan Nilai, Pajak Penjualan atas Barang Mewah, dan Bea Meterai dalam Rangka Pelaksanaan Sistem Inti Administrasi Perpajakan","url":"https://jdih.kemenkeu.go.id/api/download/A94EDEE5-E585-4EEB-B9E7-A76F616C92FB/PER-11_PJ_2025.pdf","publishedAt":"2025-05-22","retrievedAt":"2026-08-22T22:05:00.000Z"}
  ]'::jsonb,
  '[
    {"code":"TAX_INCLUSIVE_BACKSOLVING","label":"Tax-inclusive price back-solving"},
    {"code":"PKP_ELIGIBILITY","label":"PKP eligibility or turnover thresholds"},
    {"code":"EXEMPT_SUPPLY_CLASSIFICATION","label":"Exempt or non-taxable supply classification"},
    {"code":"SPECIAL_DPP_REGIME","label":"Special DPP or specific-amount regimes"},
    {"code":"LUXURY_GOODS_PPN_PPBM","label":"Luxury goods PPN and PPnBM"},
    {"code":"PPh_WITHHOLDING","label":"PPh withholding of any article"},
    {"code":"INPUT_TAX_CREDIT","label":"Input-tax credit decisions"},
    {"code":"FAKTUR_PAJAK_CORETAX","label":"Faktur Pajak or Coretax generation, serials, filing, or submission"},
    {"code":"FOREIGN_CURRENCY_TAX","label":"Foreign-currency tax calculation"},
    {"code":"CORRECTIONS","label":"Returns, refunds, corrections, penalties, and deadlines"}
  ]'::jsonb,
  'I confirm that this transaction takes place in Indonesia, falls within PMK 131/2024 Article 3, and is not subject to a separately regulated DPP or specific-amount regime. I confirm that our PKP status is recorded by us in Stdio. Stdio does not determine PKP status, taxability, exemptions, special regimes, filing duties, or eligibility.',
  'Stdio calculates amounts from the rule and choices you provide. Stdio does not determine PKP status, taxability, exemptions, special regimes, filing duties, or eligibility. Confirm these choices against your records or a qualified professional.'
)
ON CONFLICT ("id", "version") DO NOTHING;