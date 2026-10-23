ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "after_id" uuid;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_after_id_reminders_id_fk" FOREIGN KEY ("after_id") REFERENCES "public"."reminders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_after_idx" ON "reminders" USING btree ("after_id") WHERE "reminders"."after_id" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" in ('reminder','task','approval','mention','comment','decided','tasks_done','failed','escalated','rsvp','invite','calendar','chain'));