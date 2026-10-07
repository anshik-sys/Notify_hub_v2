CREATE TABLE "department_members" (
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"is_manager" boolean DEFAULT false NOT NULL,
	CONSTRAINT "department_members_department_id_user_id_pk" PRIMARY KEY("department_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "department_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"permissions" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_companyId_name_unique" UNIQUE("company_id","name")
);
--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_roles" (
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "department_members_user_id_index" ON "department_members" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "department_members" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "roles" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "system_roles_readable" ON "roles" AS PERMISSIVE FOR SELECT TO public USING (company_id is null);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_roles" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "auth_unscoped" ON "user_roles" AS PERMISSIVE FOR ALL TO "notifyhub_auth" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Hand-added below. System roles, with the fixed ids from src/lib/permissions.ts.
-- Company Admin's permissions are '{}' on purpose: loadAccess() grants it everything.
INSERT INTO "roles" ("id", "company_id", "name", "permissions") VALUES
  ('00000000-0000-4000-8000-000000000001', NULL, 'Company Admin', '{}'),
  ('00000000-0000-4000-8000-000000000002', NULL, 'Member', '{reminders.create,reminders.view,departments.view,users.view}');--> statement-breakpoint
-- unique(company_id, name) doesn't stop duplicate system role names (NULLs are distinct).
CREATE UNIQUE INDEX "roles_system_name_unique" ON "roles" ("name") WHERE "company_id" IS NULL;--> statement-breakpoint
-- Onboarding (notifyhub_auth) looks up nothing here but inserts the creator's admin row.
GRANT SELECT ON "roles" TO notifyhub_auth;--> statement-breakpoint
GRANT INSERT ON "user_roles" TO notifyhub_auth;--> statement-breakpoint
-- Backfill: the earliest user of each existing company becomes its admin.
INSERT INTO "user_roles" ("company_id", "user_id", "role_id")
SELECT DISTINCT ON ("company_id") "company_id", "id", '00000000-0000-4000-8000-000000000001'::uuid
FROM "user" WHERE "company_id" IS NOT NULL
ORDER BY "company_id", "created_at";
