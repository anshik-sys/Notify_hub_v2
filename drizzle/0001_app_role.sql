-- The web app's login role. Not the owner and not a superuser, so RLS applies.
-- Its password is set outside migrations: ALTER ROLE notifyhub_app PASSWORD '...';
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'notifyhub_app') THEN
    CREATE ROLE notifyhub_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO notifyhub_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO notifyhub_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO notifyhub_app;
