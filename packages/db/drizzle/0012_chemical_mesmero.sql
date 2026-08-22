ALTER TABLE "users" ADD COLUMN "hourly_rate" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "effective_hourly_rate" numeric(20, 4);