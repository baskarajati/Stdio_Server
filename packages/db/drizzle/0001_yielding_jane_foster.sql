-- SOL-23: the studio boundary.
--
-- Every domain table gets Row-Level Security. One studio must never read the
-- data of another studio. The server sets `app.studio_id` and switches into
-- the `studio_app` role for every request. The policy below is then the only
-- path to a row.
--
-- `FORCE ROW LEVEL SECURITY` makes the rule apply to the table owner too, so
-- a forgotten role switch fails closed. Superusers still bypass RLS: the
-- production application role must not be a superuser.

-- The restricted application role. NOLOGIN: the server reaches it with
-- `SET LOCAL ROLE studio_app` inside a request transaction, never with its
-- own credentials.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'studio_app') THEN
    CREATE ROLE studio_app NOSUPERUSER NOINHERIT NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO studio_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO studio_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studio_app;
--> statement-breakpoint
-- The tenant table. A session sees exactly its own studio row.
ALTER TABLE "studios" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Let the migration role switch into the restricted role per request.
DO $$
BEGIN
  EXECUTE format('GRANT studio_app TO %I', current_user);
END
$$;
--> statement-breakpoint
ALTER TABLE "studios" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "studios"
  USING ("id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
-- Every other table carries studio_id and the same isolation policy.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "users"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "clients"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "projects"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "project_engagements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_engagements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "project_engagements"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "quotations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quotations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "quotations"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "quotation_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quotation_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "quotation_items"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "quotation_payment_milestones" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quotation_payment_milestones" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "quotation_payment_milestones"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "variation_orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "variation_orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "variation_orders"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "variation_order_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "variation_order_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "variation_order_approvals"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "invoices"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "invoice_payments"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "invoice_receivable_components" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_receivable_components" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "invoice_receivable_components"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "vendors"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "purchase_orders"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "purchase_order_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "purchase_order_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "purchase_order_items"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "goods_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "goods_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "goods_receipts"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "goods_receipt_lines"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "timesheet_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "timesheet_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "timesheet_entries"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
-- Contract enums pinned as CHECK constraints. The contract wins every
-- argument; a value outside these sets is a bug, and the database says so.
ALTER TABLE "users" ADD CONSTRAINT users_role_check
  CHECK ("role" IN ('OWNER', 'PM', 'DESIGNER', 'FINANCE', 'PROCUREMENT'));
--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT variation_orders_status_check
  CHECK ("status" IN ('ISSUED', 'SUPERSEDED', 'VOIDED'));
--> statement-breakpoint
ALTER TABLE "variation_order_approvals" ADD CONSTRAINT variation_order_approvals_decision_check
  CHECK ("decision" IN ('APPROVED', 'REJECTED'));
--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT quotation_items_line_type_check
  CHECK ("line_type" IN ('FEE', 'BOQ', 'ALLOWANCE'));
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_status_check
  CHECK ("status" IN ('ARCHIVED', 'BACKORDERED', 'CANCELLED', 'CLOSED', 'CONFIRMED',
    'DECLINED', 'DRAFT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'SENT', 'VENDOR_DECLINED'));
--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT purchase_order_items_receiving_state_check
  CHECK ("receiving_state" IN ('backordered', 'installed', 'ordered', 'partiallyReceived', 'received'));
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT goods_receipts_kind_check
  CHECK ("kind" IN ('ORIGINAL', 'REVERSAL'));
--> statement-breakpoint
-- Numbers must stay unique inside one studio. The registers show one number
-- per document; a duplicate is a data bug.
ALTER TABLE "clients" ADD CONSTRAINT clients_number_unique
  UNIQUE ("studio_id", "client_number");
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT projects_code_unique
  UNIQUE ("studio_id", "project_code");
--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT quotations_number_version_unique
  UNIQUE ("studio_id", "quotation_number", "version");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT invoices_number_unique
  UNIQUE ("studio_id", "invoice_number");
--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT vendors_code_unique
  UNIQUE ("studio_id", "vendor_code");
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_number_unique
  UNIQUE ("studio_id", "purchase_order_number");
--> statement-breakpoint
-- Indexes for the register queries. Every list starts at studio_id.
CREATE INDEX clients_studio_idx ON "clients" ("studio_id", "updated_at");
--> statement-breakpoint
CREATE INDEX projects_studio_idx ON "projects" ("studio_id", "status");
--> statement-breakpoint
CREATE INDEX project_engagements_project_idx ON "project_engagements" ("project_id", "sort_order");
--> statement-breakpoint
CREATE INDEX quotations_studio_idx ON "quotations" ("studio_id", "updated_at");
--> statement-breakpoint
CREATE INDEX quotation_items_quotation_idx ON "quotation_items" ("quotation_id", "line_order");
--> statement-breakpoint
CREATE INDEX quotation_payment_milestones_quotation_idx
  ON "quotation_payment_milestones" ("quotation_id", "sort_order");
--> statement-breakpoint
CREATE INDEX variation_orders_project_idx ON "variation_orders" ("project_id", "issued_at");
--> statement-breakpoint
CREATE INDEX variation_order_approvals_vo_idx
  ON "variation_order_approvals" ("variation_order_id", "sequence");
--> statement-breakpoint
CREATE INDEX invoices_studio_idx ON "invoices" ("studio_id", "updated_at");
--> statement-breakpoint
CREATE INDEX invoice_payments_invoice_idx ON "invoice_payments" ("invoice_id", "paid_at");
--> statement-breakpoint
CREATE INDEX invoice_receivable_components_invoice_idx
  ON "invoice_receivable_components" ("invoice_id");
--> statement-breakpoint
CREATE INDEX vendors_studio_idx ON "vendors" ("studio_id", "updated_at");
--> statement-breakpoint
CREATE INDEX purchase_orders_studio_idx ON "purchase_orders" ("studio_id", "updated_at");
--> statement-breakpoint
CREATE INDEX purchase_order_items_po_idx ON "purchase_order_items" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX goods_receipts_po_idx ON "goods_receipts" ("purchase_order_id", "issued_at");
--> statement-breakpoint
CREATE INDEX goods_receipt_lines_receipt_idx ON "goods_receipt_lines" ("goods_receipt_id");
--> statement-breakpoint
CREATE INDEX timesheet_entries_studio_idx ON "timesheet_entries" ("studio_id", "entry_date");
--> statement-breakpoint
CREATE INDEX timesheet_entries_project_idx ON "timesheet_entries" ("project_id", "entry_date");
