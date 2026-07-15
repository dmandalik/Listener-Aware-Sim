ALTER TABLE "trials" ADD COLUMN "scene" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "assignment" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "speaker_pid" text;--> statement-breakpoint
ALTER TABLE "trials" ADD COLUMN "duration_ms" bigint;--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "served_novice" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "utterances" ADD COLUMN "served_expert" integer DEFAULT 0 NOT NULL;