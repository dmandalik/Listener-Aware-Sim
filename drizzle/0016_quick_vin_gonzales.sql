ALTER TABLE "sessions" ADD COLUMN "order_seq" integer;
--> statement-breakpoint
-- Backfill: every run collected before counterbalancing used the one fixed task order
-- (teleop -> repair -> retrieval) = sequence 1. Labeling them seeds the least-filled
-- round-robin so new participants preferentially fill the empty orders 2-6.
UPDATE "sessions" SET "order_seq" = 1 WHERE "order_seq" IS NULL;