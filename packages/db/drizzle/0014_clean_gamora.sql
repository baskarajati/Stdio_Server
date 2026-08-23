CREATE TABLE "studio_number_sequences" (
	"studio_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_number_sequences_studio_id_namespace_pk" PRIMARY KEY("studio_id","namespace")
);
--> statement-breakpoint
ALTER TABLE "studio_number_sequences" ADD CONSTRAINT "studio_number_sequences_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- SOL-131: tenant isolation for the per-studio document counter. The studio
-- boundary follows the same pattern as every domain table (SOL-23): a row is
-- visible and writable only when its studio_id equals the transaction studio.
ALTER TABLE "studio_number_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studio_number_sequences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY studio_isolation ON "studio_number_sequences"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
