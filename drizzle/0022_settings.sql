CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "require_two_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "two_factor_secret_index" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_index" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
-- Hand-added, like 0003: 2FA secrets are for Better Auth's role only. Default
-- privileges (0001) would otherwise give the app role this table.
GRANT SELECT, INSERT, UPDATE, DELETE ON "two_factor" TO notifyhub_auth;--> statement-breakpoint
REVOKE ALL ON "two_factor" FROM notifyhub_app;
