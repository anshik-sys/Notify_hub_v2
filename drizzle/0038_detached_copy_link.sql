ALTER TABLE "reminders" ADD COLUMN "replaces_series_id" uuid;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "replaces_occurs_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_replaces_series_id_reminders_id_fk" FOREIGN KEY ("replaces_series_id") REFERENCES "public"."reminders"("id") ON DELETE set null ON UPDATE no action;