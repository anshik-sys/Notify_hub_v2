CREATE TABLE "reminder_covers" (
	"reminder_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminder_covers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reminder_covers" ADD CONSTRAINT "reminder_covers_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_covers" ADD CONSTRAINT "reminder_covers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reminder_covers" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Hand-added. Audited like the photo; the bytes are noise, so excluded.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "reminder_covers" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', 'content_type', 'company_id', 'data');
