ALTER TABLE "reminder_occurrences" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "deleted_at" timestamp with time zone;