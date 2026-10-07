CREATE TABLE "slack_installations" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"bot_token_enc" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"fallback_channel_id" text,
	"fallback_channel_name" text,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_installations_teamId_unique" UNIQUE("team_id")
);
--> statement-breakpoint
ALTER TABLE "slack_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_occurrenceId_address_unique";--> statement-breakpoint
ALTER TABLE "reminder_targets" DROP CONSTRAINT "reminder_targets_kind_valid";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "slack_channel" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "slack_ts" text;--> statement-breakpoint
ALTER TABLE "reminder_targets" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "channels" text[] DEFAULT '{email}' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_occurrenceId_channel_address_unique" UNIQUE("occurrence_id","channel","address");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_channel_valid" CHECK ("deliveries"."channel" in ('email','slack'));--> statement-breakpoint
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_kind_valid" CHECK ("reminder_targets"."kind" in ('user','department','company','email','slack_channel'));--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_channels_valid" CHECK (cardinality("reminders"."channels") > 0 and "reminders"."channels" <@ array['email','slack']);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slack_installations" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);