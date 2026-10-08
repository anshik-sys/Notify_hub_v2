CREATE TABLE "reminder_shares" (
	"reminder_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	CONSTRAINT "reminder_shares_kind_valid" CHECK ("reminder_shares"."kind" in ('department','group','company'))
);
--> statement-breakpoint
ALTER TABLE "reminder_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reminder_shares" ADD CONSTRAINT "reminder_shares_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_shares" ADD CONSTRAINT "reminder_shares_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_shares_unique_idx" ON "reminder_shares" USING btree ("reminder_id","kind",coalesce("ref", ''));--> statement-breakpoint
CREATE INDEX "reminder_shares_kind_ref_index" ON "reminder_shares" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "deliveries_user_id_index" ON "deliveries" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reminder_shares" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);