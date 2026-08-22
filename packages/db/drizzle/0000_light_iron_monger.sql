CREATE TABLE "studios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"client_number" text NOT NULL,
	"name" text NOT NULL,
	"client_type" text DEFAULT 'COMPANY' NOT NULL,
	"company_name" text,
	"location" text,
	"lead_source" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"primary_contact_name" text,
	"primary_contact_email" text,
	"primary_contact_phone" text,
	"account_manager_id" uuid,
	"last_contacted_at" timestamp with time zone,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_receivable_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"settled_amount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"display_number" text,
	"client_id" uuid NOT NULL,
	"project_id" uuid,
	"milestone_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"issue_date" timestamp with time zone,
	"due_date" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"total_amount" numeric(20, 2),
	"tax_amount" numeric(20, 2),
	"collection_status" text DEFAULT 'NONE' NOT NULL,
	"collection_note" text,
	"collection_owner_id" uuid,
	"collection_reminder_date" text,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sort_order" numeric(10, 0) DEFAULT '0' NOT NULL,
	"lifecycle_status" text DEFAULT 'ACTIVE' NOT NULL,
	"contract_state" text DEFAULT 'NONE' NOT NULL,
	"current_phase_key" text,
	"phase_count" numeric(10, 0) DEFAULT '0' NOT NULL,
	"completed_phase_count" numeric(10, 0) DEFAULT '0' NOT NULL,
	"gated_by_engagement_id" uuid,
	"is_gate_satisfied" text,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"project_code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"client_id" uuid NOT NULL,
	"site_address" text,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"project_type" text DEFAULT 'INTERIOR' NOT NULL,
	"service_model" text,
	"manager_id" uuid,
	"blueprint_id" uuid,
	"budget_amount" numeric(20, 2),
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_item_id" uuid NOT NULL,
	"description_snapshot" text NOT NULL,
	"quantity" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text DEFAULT 'ORIGINAL' NOT NULL,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"delivery_reference" text NOT NULL,
	"receipt_date" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"receiver_name_snapshot" text NOT NULL,
	"evidence_file_id" uuid,
	"evidence_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(20, 4) NOT NULL,
	"received_quantity" numeric(20, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(20, 2),
	"line_total" numeric(20, 2),
	"receiving_state" text DEFAULT 'ordered' NOT NULL,
	"expected_ship_date" timestamp with time zone,
	"spec_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"purchase_order_number" text NOT NULL,
	"project_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"issue_date" timestamp with time zone NOT NULL,
	"expected_date" timestamp with time zone,
	"notes" text,
	"total_amount" numeric(20, 2),
	"is_amended" boolean DEFAULT false NOT NULL,
	"confirmed_expected_date" timestamp with time zone,
	"confirmed_total" numeric(20, 2),
	"cancellation_reason" text,
	"change_control_notes" text,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"quotation_id" uuid NOT NULL,
	"line_order" numeric(10, 0) NOT NULL,
	"line_type" text DEFAULT 'FEE' NOT NULL,
	"code" text,
	"description" text NOT NULL,
	"unit" text,
	"quantity" numeric(20, 4),
	"unit_rate" numeric(20, 2),
	"line_subtotal" numeric(20, 2),
	"line_tax_amount" numeric(20, 2),
	"line_total" numeric(20, 2),
	"source_type" text,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotation_payment_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"quotation_id" uuid NOT NULL,
	"sort_order" numeric(10, 0) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"due_trigger" text,
	"percentage" numeric(10, 4),
	"amount" numeric(20, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"quotation_number" text NOT NULL,
	"title" text NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid,
	"engagement_id" uuid,
	"version" numeric(10, 0) DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"quotation_type" text,
	"fee_model" text,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"subtotal_amount" numeric(20, 2),
	"discount_percent" numeric(10, 4),
	"discount_amount" numeric(20, 2),
	"tax_amount" numeric(20, 2),
	"total_amount" numeric(20, 2),
	"default_rate_per_sqm" numeric(20, 2),
	"valid_until" timestamp with time zone,
	"quotation_date" timestamp with time zone,
	"last_accepted_at" timestamp with time zone,
	"last_declined_at" timestamp with time zone,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"entry_date" timestamp with time zone NOT NULL,
	"hours" numeric(10, 2) NOT NULL,
	"notes" text,
	"status" text DEFAULT 'LOGGED' NOT NULL,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variation_order_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"variation_order_id" uuid NOT NULL,
	"sequence" numeric(10, 0) NOT NULL,
	"approver_id" uuid,
	"approver_name" text NOT NULL,
	"approver_role" text NOT NULL,
	"decision" text NOT NULL,
	"decision_notes" text,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variation_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"engagement_id" uuid,
	"display_number" text,
	"system_number" text,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"effective_date" timestamp with time zone NOT NULL,
	"contract_revision_id" uuid,
	"schedule_of_values_id" uuid,
	"before_fee_amount" numeric(20, 2),
	"after_fee_amount" numeric(20, 2),
	"fee_effect" numeric(20, 2) NOT NULL,
	"before_boq_amount" numeric(20, 2),
	"after_boq_amount" numeric(20, 2),
	"boq_effect" numeric(20, 2) NOT NULL,
	"before_contract_value" numeric(20, 2),
	"after_contract_value" numeric(20, 2),
	"tax_amount" numeric(20, 2),
	"total_amount" numeric(20, 2),
	"time_effect_days" numeric(10, 0),
	"before_completion_date" timestamp with time zone,
	"after_completion_date" timestamp with time zone,
	"adopted_at" timestamp with time zone,
	"adopted_by_id" uuid,
	"adoption_attestation_reference" text,
	"adoption_evidence_interpretation" text,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"vendor_code" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"website" text,
	"category" text,
	"payment_terms" text,
	"preferred" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_account_manager_id_users_id_fk" FOREIGN KEY ("account_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_receivable_components" ADD CONSTRAINT "invoice_receivable_components_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_receivable_components" ADD CONSTRAINT "invoice_receivable_components_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_collection_owner_id_users_id_fk" FOREIGN KEY ("collection_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_reversal_of_id_goods_receipts_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_payment_milestones" ADD CONSTRAINT "quotation_payment_milestones_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_payment_milestones" ADD CONSTRAINT "quotation_payment_milestones_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_engagement_id_project_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."project_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_order_approvals" ADD CONSTRAINT "variation_order_approvals_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_order_approvals" ADD CONSTRAINT "variation_order_approvals_variation_order_id_variation_orders_id_fk" FOREIGN KEY ("variation_order_id") REFERENCES "public"."variation_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_engagement_id_project_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."project_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_studio_email_idx" ON "users" USING btree ("studio_id","email");