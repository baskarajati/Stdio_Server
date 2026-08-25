ALTER TABLE "invoice_payments" ADD COLUMN "gross_amount" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "pph_amount" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "pph_percent" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "retensi_amount" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "retensi_percent" numeric(10, 4);--> statement-breakpoint
-- SOL-132: a percent is a share of the gross, so it cannot leave 0..100.
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_pph_percent_range"
  CHECK ("pph_percent" IS NULL OR ("pph_percent" >= 0 AND "pph_percent" <= 100));--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_retensi_percent_range"
  CHECK ("retensi_percent" IS NULL OR ("retensi_percent" >= 0 AND "retensi_percent" <= 100));
