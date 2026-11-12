CREATE TABLE "worker_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" text NOT NULL,
	"job" text NOT NULL,
	"outcome" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_job_runs_finished_not_before_started" CHECK ("worker_job_runs"."finished_at" >= "worker_job_runs"."started_at"),
	CONSTRAINT "worker_job_runs_duration_non_negative" CHECK ("worker_job_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "worker_job_runs_job_finished_idx" ON "worker_job_runs" USING btree ("job","finished_at");