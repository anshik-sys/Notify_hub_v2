CREATE TABLE "event_responses" (
	"reminder_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_responses_reminder_id_user_id_pk" PRIMARY KEY("reminder_id","user_id"),
	CONSTRAINT "event_responses_answer_valid" CHECK ("event_responses"."answer" in ('yes','no','maybe'))
);
--> statement-breakpoint
ALTER TABLE "event_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "occurrence_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "kind" text DEFAULT 'reminder' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_responses" ADD CONSTRAINT "event_responses_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_responses" ADD CONSTRAINT "event_responses_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_responses" ADD CONSTRAINT "event_responses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_responses_user_id_index" ON "event_responses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_invite_idx" ON "deliveries" USING btree ("reminder_id","channel","address") WHERE "deliveries"."kind" = 'invite';--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_kind_valid" CHECK (("deliveries"."kind" = 'reminder') = ("deliveries"."occurrence_id" is not null) and "deliveries"."kind" in ('reminder','invite'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" in ('reminder','task','approval','mention','comment','decided','tasks_done','failed','escalated','rsvp'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "event_responses" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Hand-added: answers are logged (RC4); the organiser's view is the audit trail.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "event_responses" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', '@user', 'company_id', 'updated_at');--> statement-breakpoint
-- Hand-added. erase_person (0042) also deletes the person's event answers (PRD 11.5).
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
     OR (object_type IN ('user_roles', 'department_members', 'group_members', 'company_approvers', 'task_assignments', 'event_responses') AND object_label = u.name)
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
