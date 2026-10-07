ALTER TABLE "companies" ADD COLUMN "follow_up_time" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "followups" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "last_followup_on" date;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "is_task" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "due_after_minutes" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_follow_up_time_valid" CHECK ("companies"."follow_up_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_task_due" CHECK (not "reminders"."is_task" or "reminders"."due_after_minutes" > 0);