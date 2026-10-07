ALTER TABLE "invitations" ADD COLUMN "department_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE POLICY "auth_unscoped" ON "department_members" AS PERMISSIVE FOR ALL TO "notifyhub_auth" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Hand-added. Invite acceptance (notifyhub_auth) validates the invite's departments
-- under the tenant policy (it sets app.company_id) and adds the memberships.
GRANT SELECT ON "departments" TO notifyhub_auth;--> statement-breakpoint
GRANT INSERT ON "department_members" TO notifyhub_auth;
