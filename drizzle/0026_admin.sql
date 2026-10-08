CREATE TABLE "company_approvers" (
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "company_approvers_company_id_user_id_pk" PRIMARY KEY("company_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "company_approvers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "default_sender_name" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "approval_mode" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "company_approvers" ADD CONSTRAINT "company_approvers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_approvers" ADD CONSTRAINT "company_approvers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_approval_mode_valid" CHECK ("companies"."approval_mode" in ('any','named'));--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_retention_min" CHECK ("companies"."retention_days" is null or "companies"."retention_days" >= 90);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "company_approvers" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "company_approvers" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'user_id', '@user', 'company_id');
