ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_kind_valid";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "announced" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_change_idx" ON "deliveries" USING btree ("reminder_id","kind","version","channel","address") WHERE "deliveries"."kind" in ('update','cancel','uninvite');--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_change_versioned" CHECK (("deliveries"."kind" in ('update','cancel','uninvite')) = ("deliveries"."version" is not null));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_kind_valid" CHECK (("deliveries"."kind" = 'reminder') = ("deliveries"."occurrence_id" is not null) and "deliveries"."kind" in ('reminder','invite','soon','update','cancel','uninvite'));