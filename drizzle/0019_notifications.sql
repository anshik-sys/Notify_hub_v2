CREATE TABLE "notification_mutes" (
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"event" text NOT NULL,
	"channel" text NOT NULL,
	CONSTRAINT "notification_mutes_user_id_event_channel_pk" PRIMARY KEY("user_id","event","channel")
);
--> statement-breakpoint
ALTER TABLE "notification_mutes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"reminder_id" uuid,
	"comment_id" uuid,
	"actor_id" text,
	"text" text NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" in ('reminder','task','approval','mention','comment','decided','tasks_done','failed'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_index" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_index" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_mutes" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK ("company_id" = nullif(current_setting('app.company_id', true), '')::uuid);