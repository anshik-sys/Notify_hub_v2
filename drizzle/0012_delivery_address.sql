ALTER TABLE "deliveries" RENAME COLUMN "email" TO "address";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_occurrenceId_email_unique";--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_occurrenceId_address_unique" UNIQUE("occurrence_id","address");