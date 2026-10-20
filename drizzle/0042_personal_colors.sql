CREATE TABLE "reminder_colors" (
	"user_id" text NOT NULL,
	"reminder_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"color" text NOT NULL,
	CONSTRAINT "reminder_colors_user_id_reminder_id_pk" PRIMARY KEY("user_id","reminder_id"),
	CONSTRAINT "reminder_colors_valid" CHECK ("reminder_colors"."color" in ('tomato','flamingo','tangerine','banana','sage','basil','peacock','blueberry','lavender','grape','graphite'))
);
--> statement-breakpoint
ALTER TABLE "reminder_colors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reminders" DROP CONSTRAINT "reminders_color_valid";--> statement-breakpoint
ALTER TABLE "reminder_colors" ADD CONSTRAINT "reminder_colors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_colors" ADD CONSTRAINT "reminder_colors_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_colors" ADD CONSTRAINT "reminder_colors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-added: a colour already set (shared, 0041) becomes its creator's own.
INSERT INTO "reminder_colors" ("user_id", "reminder_id", "company_id", "color")
  SELECT "created_by", "id", "company_id", "color" FROM "reminders" WHERE "color" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" DROP COLUMN "color";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reminder_colors" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Hand-added. erase_person (0040) also deletes the person's colour choices (PRD 11.5).
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
     OR (object_type IN ('user_roles', 'department_members', 'group_members', 'company_approvers', 'task_assignments') AND object_label = u.name)
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
