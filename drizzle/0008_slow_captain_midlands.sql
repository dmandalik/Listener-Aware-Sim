ALTER TABLE "sessions" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "layout" text;--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "layout" text;--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "completed_novice" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "completed_expert" integer DEFAULT 0 NOT NULL;