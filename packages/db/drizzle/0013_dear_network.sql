-- SOL-19: the spec-item register. The tenant-matching foreign key below
-- references projects(studio_id, id); that unique constraint is missing from
-- the committed migrations (pre-existing drift: it existed only ad hoc in the
-- dev database). Add it first so the FK is valid on a fresh database.
ALTER TABLE "projects" ADD CONSTRAINT "projects_studio_id_unq" UNIQUE ("studio_id","id");--> statement-breakpoint
CREATE TABLE "spec_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"room" text,
	"quantity_label" text,
	"brand" text,
	"category" text,
	"entity_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_items_studio_id_unq" UNIQUE("studio_id","id")
);
--> statement-breakpoint
ALTER TABLE "spec_items" ADD CONSTRAINT "spec_items_studio_id_studios_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("studio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_items" ADD CONSTRAINT "spec_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_items" ADD CONSTRAINT "spec_items_project_tenant_fk" FOREIGN KEY ("studio_id","project_id") REFERENCES "public"."projects"("studio_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- SOL-23 boundary: the spec-item register is tenant-isolated like every
-- other table. FORCE makes the rule apply to the table owner too.
ALTER TABLE "spec_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "spec_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY studio_isolation ON "spec_items"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);--> statement-breakpoint
-- Register pattern: every list starts at studio_id.
CREATE INDEX spec_items_studio_idx ON "spec_items" ("studio_id", "updated_at");--> statement-breakpoint
CREATE INDEX spec_items_project_idx ON "spec_items" ("project_id", "updated_at");
