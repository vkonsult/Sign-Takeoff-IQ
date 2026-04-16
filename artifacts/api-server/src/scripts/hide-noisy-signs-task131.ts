/**
 * Task #131 — Soft-hide noisy extracted_signs records for two affected jobs.
 *
 * Sets hidden = true on rows where sign_identifier or location:
 *   - starts with '('  (IBC occupancy codes, parenthetical annotations)
 *   - ends with  ')'   (parenthesis fragments like "CMU)")
 *   - exceeds 17 chars (no real room label is longer than "DIRECTOR'S OFFICE")
 *
 * Affected jobs:
 *   a3336c64-965b-4a06-848e-920b2eb81ae7  (floor plans)
 *   fb807b7f-d98b-4b24-a1f9-c52a866ac453  (Church Plan All Pages)
 *
 * This script is idempotent — re-running it is safe (rows already hidden are skipped).
 *
 * Run from workspace root:
 *   node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
 *     artifacts/api-server/src/scripts/hide-noisy-signs-task131.ts
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const JOB_IDS = [
  "a3336c64-965b-4a06-848e-920b2eb81ae7",
  "fb807b7f-d98b-4b24-a1f9-c52a866ac453",
];

async function main() {
  const countBefore = await db.execute(
    sql.raw(`
      SELECT COUNT(*) AS cnt
      FROM extracted_signs
      WHERE job_id IN (${JOB_IDS.map((id) => `'${id}'`).join(", ")})
        AND (
          sign_identifier LIKE '(%'
          OR sign_identifier LIKE '%)%'
          OR location      LIKE '(%'
          OR location      LIKE '%)%'
          OR LENGTH(location)       > 17
          OR LENGTH(sign_identifier) > 17
        )
        AND hidden = false
    `)
  );
  const before = (countBefore.rows[0] as { cnt: string }).cnt;
  console.log(`Records matching noisy criteria (hidden=false): ${before}`);

  const result = await db.execute(
    sql.raw(`
      UPDATE extracted_signs
      SET hidden = true
      WHERE job_id IN (${JOB_IDS.map((id) => `'${id}'`).join(", ")})
        AND (
          sign_identifier LIKE '(%'
          OR sign_identifier LIKE '%)%'
          OR location      LIKE '(%'
          OR location      LIKE '%)%'
          OR LENGTH(location)       > 17
          OR LENGTH(sign_identifier) > 17
        )
        AND hidden = false
    `)
  );

  console.log(`Updated ${result.rowCount ?? 0} rows → hidden = true`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
