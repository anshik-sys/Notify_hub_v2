ALTER TABLE "slack_installations" ADD COLUMN "digest_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "digest_time" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "digest_channel_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "digest_user_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "last_digest_on" date;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_digest_time_valid" CHECK ("slack_installations"."digest_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');