ALTER TABLE "studios" RENAME COLUMN "id" TO "studio_id";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "access_tokens" DROP CONSTRAINT "access_tokens_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "clients" DROP CONSTRAINT "clients_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "invoice_payments" DROP CONSTRAINT "invoice_payments_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "invoice_receivable_components" DROP CONSTRAINT "invoice_receivable_components_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "project_changes" DROP CONSTRAINT "project_changes_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "project_engagements" DROP CONSTRAINT "project_engagements_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" DROP CONSTRAINT "goods_receipt_lines_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "goods_receipts" DROP CONSTRAINT "goods_receipts_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "quotation_items" DROP CONSTRAINT "quotation_items_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "quotation_payment_milestones" DROP CONSTRAINT "quotation_payment_milestones_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "quotations" DROP CONSTRAINT "quotations_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "timesheet_entries" DROP CONSTRAINT "timesheet_entries_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "variation_order_approvals" DROP CONSTRAINT "variation_order_approvals_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "variation_orders" DROP CONSTRAINT "variation_orders_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "vendors" DROP CONSTRAINT "vendors_studio_id_studios_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_receivable_components" ADD CONSTRAINT "invoice_receivable_components_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_changes" ADD CONSTRAINT "project_changes_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_payment_milestones" ADD CONSTRAINT "quotation_payment_milestones_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_order_approvals" ADD CONSTRAINT "variation_order_approvals_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;