ALTER TABLE "task_assignments" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
CREATE POLICY "auth_unscoped" ON "slack_installations" AS PERMISSIVE FOR ALL TO "notifyhub_auth" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Hand-added: the interactions endpoint maps team_id -> company via notifyhub_auth.
GRANT SELECT ON "slack_installations" TO notifyhub_auth;
