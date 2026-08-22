CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" text DEFAULT 'PROCESSING' NOT NULL,
	"response_status" text,
	"response_body" jsonb,
	"response_etag" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"change_number" text NOT NULL,
	"change_type" text DEFAULT 'SCOPE' NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "variation_orders" ALTER COLUMN "engagement_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "engagement_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "progress_certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "billing_basis" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_mode" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_rule_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_confirmations" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "dpp_amount" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_changes" ADD CONSTRAINT "project_changes_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_changes" ADD CONSTRAINT "project_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_changes" ADD CONSTRAINT "project_changes_engagement_id_project_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."project_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_studio_key_idx" ON "idempotency_keys" USING btree ("studio_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_completed_idx" ON "idempotency_keys" USING btree ("completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_changes_studio_number_idx" ON "project_changes" USING btree ("studio_id","change_number");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_engagement_id_project_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."project_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- SOL-28: the new tables join the studio boundary. Same policy as migration
-- 0001: one studio sees only its own rows, enforced by the database.
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "idempotency_keys"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "project_changes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_changes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY studio_isolation ON "project_changes"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
