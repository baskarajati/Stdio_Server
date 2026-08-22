ALTER TABLE "clients" DROP CONSTRAINT "clients_account_manager_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_account_manager_tenant_fk" FOREIGN KEY ("studio_id","account_manager_id") REFERENCES "public"."users"("studio_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_studio_id_unq" UNIQUE("studio_id","id");