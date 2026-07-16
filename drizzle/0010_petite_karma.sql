CREATE TABLE "surveys" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"prolific_pid" text,
	"role" text,
	"age_range" text,
	"gender" text,
	"gender_other" text,
	"race" jsonb,
	"race_other" text,
	"tlx_mental" integer,
	"tlx_physical" integer,
	"tlx_temporal" integer,
	"tlx_performance" integer,
	"tlx_effort" integer,
	"tlx_frustration" integer,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "surveys_session_uq" ON "surveys" USING btree ("session_id");