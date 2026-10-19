ALTER TABLE "platform_alerts" ADD COLUMN "kind" text DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_alerts" DROP CONSTRAINT "platform_alerts_company_id_on_date_pk";--> statement-breakpoint
ALTER TABLE "platform_alerts" ADD CONSTRAINT "platform_alerts_company_id_on_date_kind_pk" PRIMARY KEY("company_id","on_date","kind");
