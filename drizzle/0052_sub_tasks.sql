ALTER TABLE "reminders" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_parent_id_reminders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_parent_idx" ON "reminders" USING btree ("parent_id") WHERE "reminders"."parent_id" is not null;