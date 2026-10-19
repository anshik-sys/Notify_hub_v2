ALTER TABLE "companies" ADD COLUMN "escalate_after_days" integer;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_escalate_after_days_valid" CHECK ("companies"."escalate_after_days" is null or "companies"."escalate_after_days" between 1 and 60);--> statement-breakpoint
-- escalated_at is worker bookkeeping, like followups: kept out of the audit log.
DROP TRIGGER audit ON "task_assignments";--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON "task_assignments" FOR EACH ROW EXECUTE FUNCTION audit_row('company_id', 'reminder_id', '@user', 'company_id', 'followups', 'last_followup_on', 'snoozed_until', 'created_at', 'escalated_at');
