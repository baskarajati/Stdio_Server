CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_tokens_token_idx" ON "access_tokens" USING btree ("token");--> statement-breakpoint
-- SOL-28: the token table joins the studio boundary with one documented
-- exception. The server resolves a bearer token BEFORE it knows the studio,
-- so SELECT opens to exact-token lookup (the token value is the credential).
-- Every write stays tenant-scoped through the isolation policy.
ALTER TABLE "access_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "access_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_token_lookup ON "access_tokens"
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY studio_isolation ON "access_tokens"
  USING ("studio_id" = current_setting('app.studio_id', true)::uuid)
  WITH CHECK ("studio_id" = current_setting('app.studio_id', true)::uuid);
