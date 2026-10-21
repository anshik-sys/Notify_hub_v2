ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_kind_valid";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "occurs_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "before_minutes" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_soon_idx" ON "deliveries" USING btree ("reminder_id","occurs_at","before_minutes","channel","address") WHERE "deliveries"."kind" = 'soon';--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_soon_keyed" CHECK (("deliveries"."kind" = 'soon') = ("deliveries"."occurs_at" is not null and "deliveries"."before_minutes" is not null));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_kind_valid" CHECK (("deliveries"."kind" = 'reminder') = ("deliveries"."occurrence_id" is not null) and "deliveries"."kind" in ('reminder','invite','soon'));