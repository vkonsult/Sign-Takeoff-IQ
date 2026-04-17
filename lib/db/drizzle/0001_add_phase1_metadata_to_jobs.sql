-- Add Phase 1 intake metadata columns to jobs table.
-- These fields are populated by runPhase1Intake() on the primary data file
-- during PDF processing (pdf-processor.ts) and surfaced on the job detail page.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "project_name" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "jurisdiction" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "issue_date" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "drawing_index_page_num" integer;
