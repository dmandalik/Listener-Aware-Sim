CREATE TABLE "trial_surveys" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"trial_index" integer NOT NULL,
	"prolific_pid" text,
	"assignment" text,
	"task_id" text,
	"layout" text,
	"scene" text,
	"utterance_id" integer,
	"speaker_pid" text,
	"tlx_mental" integer,
	"tlx_physical" integer,
	"tlx_temporal" integer,
	"tlx_performance" integer,
	"tlx_effort" integer,
	"tlx_frustration" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trial_surveys_session_trial_uq" ON "trial_surveys" USING btree ("session_id","trial_index");