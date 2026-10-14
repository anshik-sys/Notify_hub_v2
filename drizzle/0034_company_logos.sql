CREATE TABLE "company_logos" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_logos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "company_logos" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Audited like other company data; the bytes are noise, so excluded.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "company_logos" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'company_id', 'content_type', 'company_id', 'data');
