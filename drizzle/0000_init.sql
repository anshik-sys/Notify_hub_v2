CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"time_zone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_companyId_name_unique" UNIQUE("company_id","name")
);
--> statement-breakpoint
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "companies" AS PERMISSIVE FOR ALL TO public USING ("id" = current_setting('app.company_id', true)::uuid) WITH CHECK ("id" = current_setting('app.company_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "departments" AS PERMISSIVE FOR ALL TO public USING ("company_id" = current_setting('app.company_id', true)::uuid) WITH CHECK ("company_id" = current_setting('app.company_id', true)::uuid);