-- Add ai_call_logs table to capture every Gemini API call made during job scans.
-- Records prompt text, JSON response, token counts, duration, call type and page number.

CREATE TABLE IF NOT EXISTS "ai_call_logs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "job_id" uuid,
        "page_number" integer,
        "call_type" text NOT NULL,
        "prompt" text NOT NULL,
        "response_json" jsonb,
        "input_tokens" integer DEFAULT 0 NOT NULL,
        "output_tokens" integer DEFAULT 0 NOT NULL,
        "duration_ms" integer DEFAULT 0 NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_job_id_jobs_id_fk"
        FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "ai_call_logs_job_id_created_at_idx"
        ON "ai_call_logs" USING btree ("job_id","created_at");

CREATE INDEX IF NOT EXISTS "ai_call_logs_call_type_idx"
        ON "ai_call_logs" USING btree ("call_type");
