ALTER TABLE "reminders" ADD COLUMN "is_event" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "meeting_url" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "notify_before" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_event_kind" CHECK (not ("reminders"."is_task" and "reminders"."is_event"));--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_event_length" CHECK (not "reminders"."is_event" or "reminders"."duration_minutes" > 0);