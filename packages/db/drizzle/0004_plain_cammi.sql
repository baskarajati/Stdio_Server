ALTER TABLE "project_engagements" ADD COLUMN "contract_value" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "project_engagements" ADD COLUMN "currency" text DEFAULT 'IDR' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD COLUMN "transaction_price" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_studio_id_unq" UNIQUE("studio_id","id");