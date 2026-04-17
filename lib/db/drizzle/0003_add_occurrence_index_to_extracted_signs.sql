-- Add stable occurrence numbering columns to extracted_signs.
-- These are set server-side during sign extraction so that repositioning
-- a sign marker on the canvas never changes its occurrence index.

ALTER TABLE "extracted_signs"
  ADD COLUMN IF NOT EXISTS "occurrence_index" integer,
  ADD COLUMN IF NOT EXISTS "occurrence_total" integer;
