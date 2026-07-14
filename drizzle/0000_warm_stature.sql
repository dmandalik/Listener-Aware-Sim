CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"t" bigint NOT NULL,
	"session_id" text NOT NULL,
	"ev" text NOT NULL,
	"payload" jsonb NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"prolific_pid" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"consented_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"prolific_pid" text NOT NULL,
	"role" text NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trials" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"trial_index" integer NOT NULL,
	"task_id" text NOT NULL,
	"seed" integer NOT NULL,
	"condition" jsonb NOT NULL,
	"utterance_text" text,
	"speaker_session_id" text,
	"correct" boolean,
	"cost" integer,
	"target_id" text,
	"chosen_id" text,
	"reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "utterances" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"seed" integer NOT NULL,
	"scene" text NOT NULL,
	"text" text NOT NULL,
	"author_session_id" text NOT NULL,
	"author_pid" text,
	"times_served" integer DEFAULT 0 NOT NULL,
	"listener_successes" integer DEFAULT 0 NOT NULL,
	"listener_trials" integer DEFAULT 0 NOT NULL,
	"success_rate" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_prolific_pid_participants_prolific_pid_fk" FOREIGN KEY ("prolific_pid") REFERENCES "public"."participants"("prolific_pid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_session_idx" ON "events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "events_ev_idx" ON "events" USING btree ("ev");--> statement-breakpoint
CREATE INDEX "sessions_pid_idx" ON "sessions" USING btree ("prolific_pid");--> statement-breakpoint
CREATE UNIQUE INDEX "trials_session_index_uq" ON "trials" USING btree ("session_id","trial_index");--> statement-breakpoint
CREATE INDEX "trials_session_idx" ON "trials" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "utterances_pool_idx" ON "utterances" USING btree ("task_id","seed","scene");