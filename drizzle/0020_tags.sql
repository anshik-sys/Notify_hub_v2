ALTER TABLE "reminders" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "reminders_tags_idx" ON "reminders" USING gin ("tags");