CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text,
	"object_label" text,
	"changes" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_log_company_id_at_index" ON "audit_log" USING btree ("company_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_company_id_object_type_object_id_index" ON "audit_log" USING btree ("company_id","object_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_log_company_id_actor_id_index" ON "audit_log" USING btree ("company_id","actor_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Hand-added. One generic trigger per audited table (PRD 9.1).
-- Args: company column, id column, label column ('@user' = the row's person's
-- name), then columns NEVER recorded (secrets and noise). Rows are written
-- only when a person made the change (app.actor_id, set by withTenant).
-- SECURITY DEFINER: the app role has no write access to audit_log at all.
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  actor text := nullif(current_setting('app.actor_id', true), '');
  old_j jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_j jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  row_j jsonb := coalesce(new_j, old_j);
  skip text[] := TG_ARGV[3:];
  diff jsonb := '{}';
  k text;
  v jsonb;
  label text;
BEGIN
  IF actor IS NULL OR row_j->>TG_ARGV[0] IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR k, v IN SELECT * FROM jsonb_each(new_j) LOOP
      IF NOT (k = ANY(skip)) AND v IS DISTINCT FROM old_j->k THEN
        diff := diff || jsonb_build_object(k, jsonb_build_array(old_j->k, v));
      END IF;
    END LOOP;
    IF diff = '{}'::jsonb THEN RETURN NULL; END IF;
  ELSE
    diff := row_j - skip;
  END IF;
  label := CASE WHEN TG_ARGV[2] = '@user' THEN (SELECT name FROM "user" WHERE id = row_j->>'user_id') ELSE row_j->>TG_ARGV[2] END;
  INSERT INTO audit_log (company_id, actor_id, actor_name, action, object_type, object_id, object_label, changes)
  VALUES (
    (row_j->>TG_ARGV[0])::uuid, actor, (SELECT name FROM "user" WHERE id = actor),
    CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
    TG_TABLE_NAME, row_j->>TG_ARGV[1], left(label, 200), diff
  );
  RETURN NULL;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "reminders" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'id', 'title', 'company_id', 'updated_at', 'send_now_at');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "reminder_targets" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', 'kind', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "reminder_shares" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', 'kind', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "departments" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'id', 'name', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "department_members" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'department_id', '@user', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "groups" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'id', 'name', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "group_members" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'group_id', '@user', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "roles" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'id', 'name', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "user_roles" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'user_id', '@user', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "invitations" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'id', 'email', 'company_id', 'token_hash');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "comments" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'id', 'body', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "task_assignments" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', '@user', 'company_id', 'followups', 'last_followup_on', 'snoozed_until', 'created_at');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "attachments" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', 'file_name', 'company_id');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "companies" FOR EACH ROW EXECUTE FUNCTION audit_row('id', 'id', 'name');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "slack_installations" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'team_id', 'team_name', 'company_id', 'bot_token_enc', 'last_digest_on');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'id', 'name', 'company_id', 'updated_at', 'created_at', 'email_verified', 'image');--> statement-breakpoint
-- Append-only and unforgeable: the app role only reads (through RLS).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "audit_log" FROM notifyhub_app;
