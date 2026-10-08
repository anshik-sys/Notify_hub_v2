CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"id" integer PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Hand-added. Better Auth's limiter table is for the auth role only; ours and
-- the heartbeat are for the app role (no RLS: not company data).
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit" TO notifyhub_auth;--> statement-breakpoint
REVOKE ALL ON "rate_limit" FROM notifyhub_app;
