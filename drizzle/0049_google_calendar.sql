CREATE TABLE "google_calendar_entries" (
	"user_id" text NOT NULL,
	"reminder_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_calendar_entries_user_id_reminder_id_pk" PRIMARY KEY("user_id","reminder_id")
);
--> statement-breakpoint
ALTER TABLE "google_calendar_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "google_calendars" (
	"user_id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"google_email" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_enc" text,
	"access_expires_at" timestamp with time zone,
	"calendar_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_calendars_status_valid" CHECK ("google_calendars"."status" in ('active','revoked'))
);
--> statement-breakpoint
ALTER TABLE "google_calendars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "google_calendar_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "google_calendar_entries" ADD CONSTRAINT "google_calendar_entries_user_id_google_calendars_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."google_calendars"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_entries" ADD CONSTRAINT "google_calendar_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendars" ADD CONSTRAINT "google_calendars_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendars" ADD CONSTRAINT "google_calendars_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" in ('reminder','task','approval','mention','comment','decided','tasks_done','failed','escalated','rsvp','invite','calendar'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "google_calendar_entries" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "google_calendars" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Hand-added: connecting and disconnecting are logged; tokens and sync bookkeeping never are.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "google_calendars" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'user_id', '@user', 'company_id', 'refresh_token_enc', 'access_token_enc', 'access_expires_at', 'calendar_id', 'last_synced_at', 'last_error');--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "google_calendar_entries" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', '@user', 'company_id', 'hash', 'synced_at');--> statement-breakpoint
-- Hand-added. erase_person (0044) also deletes the Google Calendar connection and its tokens (PRD 11.5).
CREATE OR REPLACE FUNCTION erase_person(target text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  caller text := current_setting('app.actor_id', true);
  company uuid := nullif(current_setting('app.company_id', true), '')::uuid;
  u "user"%ROWTYPE;
BEGIN
  SELECT * INTO u FROM "user" WHERE id = target FOR UPDATE;
  IF u.id IS NULL OR company IS NULL OR u.company_id IS DISTINCT FROM company THEN RAISE EXCEPTION 'erase_person: not in this company'; END IF;
  IF u.deactivated_at IS NULL THEN RAISE EXCEPTION 'erase_person: deactivate first'; END IF;
  IF u.erased_at IS NOT NULL THEN RAISE EXCEPTION 'erase_person: already erased'; END IF;
  PERFORM set_config('app.actor_id', '', true);

  DELETE FROM session WHERE user_id = target;
  DELETE FROM account WHERE user_id = target;
  DELETE FROM two_factor WHERE user_id = target;
  DELETE FROM verification WHERE value = target;

  DELETE FROM user_roles WHERE user_id = target;
  DELETE FROM department_members WHERE user_id = target;
  DELETE FROM group_members WHERE user_id = target;
  DELETE FROM company_approvers WHERE user_id = target;
  DELETE FROM notification_mutes WHERE user_id = target;
  DELETE FROM user_photos WHERE user_id = target;
  DELETE FROM reminder_colors WHERE user_id = target;
  DELETE FROM event_responses WHERE user_id = target;
  DELETE FROM google_calendars WHERE user_id = target;
  DELETE FROM notifications WHERE user_id = target;
  DELETE FROM comment_mentions WHERE user_id = target;

  -- Audit rows about their comments lose the text before the text goes.
  UPDATE audit_log SET changes = changes - 'body', object_label = 'Comment by a deleted person'
   WHERE company_id = company AND object_type = 'comments'
     AND object_id IN (SELECT id::text FROM comments WHERE author_id = target);
  UPDATE comments SET body = '', deleted_at = coalesce(deleted_at, now()) WHERE author_id = target;

  UPDATE deliveries SET address = 'erased' WHERE company_id = company AND (user_id = target OR lower(address) = lower(u.email));
  DELETE FROM reminder_targets WHERE company_id = company AND kind = 'email' AND lower(ref) = lower(u.email);
  DELETE FROM invitations WHERE company_id = company AND lower(email) = lower(u.email);

  UPDATE audit_log SET actor_name = 'Deleted person' WHERE actor_id = target;
  UPDATE audit_log SET changes = '{}'::jsonb, object_label = 'Deleted person'
   WHERE company_id = company AND object_type = 'user' AND object_id = target;
  UPDATE audit_log SET object_label = 'Deleted person'
   WHERE company_id = company AND (changes->>'user_id' = target
     OR (object_type IN ('user_roles', 'department_members', 'group_members', 'company_approvers', 'task_assignments', 'event_responses', 'google_calendars') AND object_label = u.name)
     OR lower(object_label) = lower(u.email));
  UPDATE audit_log SET changes = replace(changes::text, u.email, 'erased')::jsonb
   WHERE company_id = company AND strpos(changes::text, u.email) > 0;

  UPDATE "user" SET name = 'Deleted person', email = 'deleted-' || target || '@erased.invalid', email_verified = false,
    image = NULL, time_zone = NULL, two_factor_enabled = false
   WHERE id = target;

  PERFORM set_config('app.actor_id', coalesce(caller, ''), true);
  UPDATE "user" SET erased_at = now() WHERE id = target;
END
$fn$;
