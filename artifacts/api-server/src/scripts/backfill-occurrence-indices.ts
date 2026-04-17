/**
 * One-time backfill: populate occurrence_index and occurrence_total on all
 * extracted_signs rows that currently have null values.
 *
 * Grouping key (mirrors the rule engine in pdf-processor.ts, plus job_file_id
 * to keep groups scoped to a single file):
 *   sign_type + sign_identifier + LOWER(TRIM(COALESCE(location, ''))) + page_number + job_file_id
 *
 * All groups — including singletons — receive explicit values:
 *   - Groups with > 1 member get a 1-based occurrence_index and occ_total = group size
 *   - Singletons get occurrence_index = 1, occurrence_total = 1
 *
 * This ensures NO rows remain null after the backfill, eliminating any
 * reliance on the legacy coordinate-clustering fallback in the frontend.
 *
 * The script is idempotent: it only touches rows where BOTH fields are null,
 * so re-running after a partial success is safe.
 *
 * Run from workspace root:
 *   node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
 *     artifacts/api-server/src/scripts/backfill-occurrence-indices.ts
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function backfillOccurrenceIndices() {
  console.log("━━━ Backfill: occurrence_index / occurrence_total ━━━\n");

  // Count rows that need updating before we start.
  const beforeResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt
    FROM extracted_signs
    WHERE occurrence_index IS NULL AND occurrence_total IS NULL
  `);
  const totalNull = Number((beforeResult.rows[0] as { cnt: string }).cnt);
  console.log(`Rows with null occurrence fields: ${totalNull}`);

  if (totalNull === 0) {
    console.log("Nothing to do — all rows already have occurrence values.");
    return;
  }

  // Use a CTE with window functions to compute the group size and 1-based rank
  // for every row that still has null occurrence fields.
  //
  // ALL groups receive explicit values — including singletons (idx=1, total=1)
  // — so that no rows rely on the legacy coordinate-clustering fallback.
  //
  // Location normalization: LOWER(TRIM(COALESCE(location, ''))) mirrors the
  // server-side extraction logic in pdf-processor.ts which calls
  // .toLowerCase().trim() before building the grouping key.
  //
  // Ordering within each group: created_at ASC, id ASC gives a deterministic
  // tiebreaker consistent with insertion order (rows were inserted sequentially
  // during rule-engine processing).
  const updateResult = await db.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY
            sign_type,
            sign_identifier,
            LOWER(TRIM(COALESCE(location, ''))),
            page_number,
            job_file_id
          ORDER BY created_at ASC, id ASC
        ) AS occ_idx,
        COUNT(*) OVER (
          PARTITION BY
            sign_type,
            sign_identifier,
            LOWER(TRIM(COALESCE(location, ''))),
            page_number,
            job_file_id
        ) AS occ_total
      FROM extracted_signs
      WHERE occurrence_index IS NULL AND occurrence_total IS NULL
    )
    UPDATE extracted_signs
    SET
      occurrence_index = ranked.occ_idx::integer,
      occurrence_total = ranked.occ_total::integer
    FROM ranked
    WHERE extracted_signs.id = ranked.id
  `);

  const rowsUpdated = updateResult.rowCount ?? 0;
  console.log(`Updated ${rowsUpdated} row(s) with occurrence indices.`);

  // Verify: no null rows should remain at all.
  const afterResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt
    FROM extracted_signs
    WHERE occurrence_index IS NULL OR occurrence_total IS NULL
  `);
  const remainingNull = Number((afterResult.rows[0] as { cnt: string }).cnt);

  if (remainingNull > 0) {
    console.error(
      `\n⚠  WARNING: ${remainingNull} row(s) still have null occurrence fields.` +
      ` If these rows have one null column and one non-null column (partial state),` +
      ` re-running this script will NOT fix them — manual remediation is required.` +
      ` Otherwise, re-running the script is safe.`
    );
    process.exit(1);
  }

  console.log("\n✓ Backfill complete. Zero rows have null occurrence fields.");
}

backfillOccurrenceIndices().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
