CREATE TABLE "reminder_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reminder_id" uuid NOT NULL,
	"occurs_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_occurrences_reminderId_occursAt_unique" UNIQUE("reminder_id","occurs_at"),
	CONSTRAINT "reminder_occurrences_status_valid" CHECK ("reminder_occurrences"."status" in ('sending','sent','skipped','missed'))
);
--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_reminderId_email_unique";--> statement-breakpoint
ALTER TABLE "reminders" DROP CONSTRAINT "reminders_status_valid";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "occurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "recurrence" jsonb;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "anchor_local" text;--> statement-breakpoint
-- Hand-added backfill: existing reminders are one-time, anchored at send_at in the company zone.
UPDATE "reminders" r SET "time_zone" = c."time_zone",
  "anchor_local" = to_char(r."send_at" AT TIME ZONE c."time_zone", 'YYYY-MM-DD"T"HH24:MI')
  FROM "companies" c WHERE c."id" = r."company_id";--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "time_zone" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "anchor_local" SET NOT NULL;--> statement-breakpoint
-- One occurrence for every reminder that already has deliveries, then link them.
INSERT INTO "reminder_occurrences" ("company_id", "reminder_id", "occurs_at", "status")
  SELECT r."company_id", r."id", r."send_at", CASE WHEN r."status" = 'sent' THEN 'sent' ELSE 'sending' END
  FROM "reminders" r WHERE EXISTS (SELECT 1 FROM "deliveries" d WHERE d."reminder_id" = r."id");--> statement-breakpoint
UPDATE "deliveries" d SET "occurrence_id" = o."id" FROM "reminder_occurrences" o WHERE o."reminder_id" = d."reminder_id";--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "occurrence_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_occurrence_id_reminder_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."reminder_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_reminder_id_index" ON "deliveries" USING btree ("reminder_id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_occurrenceId_email_unique" UNIQUE("occurrence_id","email");--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_status_valid" CHECK ("reminders"."status" in ('pending_approval','rejected','scheduled','paused','sending','sent','cancelled'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reminder_occurrences" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);