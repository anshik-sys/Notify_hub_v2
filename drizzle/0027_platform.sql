CREATE TABLE "platform_alerts" (
	"company_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	CONSTRAINT "platform_alerts_company_id_on_date_pk" PRIMARY KEY("company_id","on_date")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"daily_volume_alert" integer
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_alerts" ADD CONSTRAINT "platform_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-added. Cross-company reads for the platform-owner console, without
-- giving the web app the owner connection: SECURITY DEFINER functions that
-- return aggregates only, and only when the caller set app.platform = 'on'
-- in its transaction (src/lib/platform.ts does, after checking the owner).
CREATE OR REPLACE FUNCTION platform_guard() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF coalesce(current_setting('app.platform', true), '') <> 'on' THEN
    RAISE EXCEPTION 'platform functions need app.platform';
  END IF;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform_companies()
RETURNS TABLE (id uuid, name text, domain text, time_zone text, created_at timestamptz, suspended_at timestamptz, people int, admins text,
  scheduled int, sent_24h int, failed_24h int, sent_30d int, failed_30d int, last_activity timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  PERFORM platform_guard();
  RETURN QUERY
  SELECT c.id, c.name, c.domain, c.time_zone, c.created_at, c.suspended_at,
    (SELECT count(*)::int FROM "user" u WHERE u.company_id = c.id AND u.deactivated_at IS NULL),
    (SELECT string_agg(DISTINCT u.email, ', ') FROM user_roles ur JOIN "user" u ON u.id = ur.user_id
       WHERE ur.company_id = c.id AND ur.role_id = '00000000-0000-4000-8000-000000000001' AND u.deactivated_at IS NULL),
    (SELECT count(*)::int FROM reminders r WHERE r.company_id = c.id AND r.status = 'scheduled'),
    (SELECT count(*)::int FROM deliveries d WHERE d.company_id = c.id AND d.status = 'sent' AND d.sent_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM deliveries d WHERE d.company_id = c.id AND d.status = 'failed' AND d.updated_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM deliveries d WHERE d.company_id = c.id AND d.status = 'sent' AND d.sent_at > now() - interval '30 days'),
    (SELECT count(*)::int FROM deliveries d WHERE d.company_id = c.id AND d.status = 'failed' AND d.updated_at > now() - interval '30 days'),
    (SELECT max(r.updated_at) FROM reminders r WHERE r.company_id = c.id)
  FROM companies c ORDER BY c.created_at;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform_queue()
RETURNS TABLE (queued int, sending int, failed_24h int, oldest_queued_seconds int, overdue_reminders int, worker_seconds int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  PERFORM platform_guard();
  RETURN QUERY SELECT
    (SELECT count(*)::int FROM deliveries WHERE status = 'queued'),
    (SELECT count(*)::int FROM deliveries WHERE status = 'sending'),
    (SELECT count(*)::int FROM deliveries WHERE status = 'failed' AND updated_at > now() - interval '24 hours'),
    (SELECT extract(epoch FROM now() - min(created_at))::int FROM deliveries WHERE status = 'queued'),
    (SELECT count(*)::int FROM reminders r JOIN companies c ON c.id = r.company_id
       WHERE r.status = 'scheduled' AND r.send_at < now() - interval '2 minutes' AND c.suspended_at IS NULL),
    (SELECT extract(epoch FROM now() - at)::int FROM worker_heartbeat WHERE id = 1);
END
$fn$;--> statement-breakpoint
-- The Member system role (fixed id) is read-only to the app role by design.
CREATE OR REPLACE FUNCTION platform_set_member_role(perms text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  PERFORM platform_guard();
  UPDATE roles SET permissions = perms WHERE id = '00000000-0000-4000-8000-000000000002' AND company_id IS NULL;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_companies(), platform_queue(), platform_set_member_role(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_companies(), platform_queue(), platform_set_member_role(text[]) TO notifyhub_app;--> statement-breakpoint
INSERT INTO platform_settings (id, daily_volume_alert) VALUES (1, NULL) ON CONFLICT DO NOTHING;
