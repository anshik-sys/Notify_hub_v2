CREATE TABLE "task_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reminder_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"done_at" timestamp with time zone,
	"followups" integer DEFAULT 0 NOT NULL,
	"last_followup_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_assignments_occurrenceId_userId_unique" UNIQUE("occurrence_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "task_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_occurrence_id_reminder_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."reminder_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_assignments_user_id_index" ON "task_assignments" USING btree ("user_id");--> statement-breakpoint
-- Hand-added: carry existing task state over before dropping it from deliveries.
INSERT INTO "task_assignments" ("company_id", "reminder_id", "occurrence_id", "user_id", "done_at", "followups", "last_followup_on")
  SELECT d."company_id", d."reminder_id", d."occurrence_id", d."user_id", d."done_at", d."followups", d."last_followup_on"
  FROM "deliveries" d JOIN "reminders" r ON r."id" = d."reminder_id"
  WHERE r."is_task" AND d."user_id" IS NOT NULL
  ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "deliveries" DROP COLUMN "done_at";--> statement-breakpoint
ALTER TABLE "deliveries" DROP COLUMN "followups";--> statement-breakpoint
ALTER TABLE "deliveries" DROP COLUMN "last_followup_on";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "task_assignments" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);