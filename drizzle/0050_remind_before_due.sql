ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_kind_valid";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_soon_keyed";--> statement-breakpoint
DROP INDEX "deliveries_soon_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_soon_idx" ON "deliveries" USING btree ("reminder_id","occurs_at","before_minutes","channel","address") WHERE "deliveries"."kind" in ('soon','due');--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_kind_valid" CHECK (("deliveries"."kind" = 'reminder') = ("deliveries"."occurrence_id" is not null) and "deliveries"."kind" in ('reminder','invite','soon','due','update','cancel','uninvite'));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_soon_keyed" CHECK (("deliveries"."kind" in ('soon','due')) = ("deliveries"."occurs_at" is not null and "deliveries"."before_minutes" is not null));