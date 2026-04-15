/**
 * Re-runs the full PDF-only pipeline for every job in the DB.
 * Clears existing PDF-sourced signs and resets page stats before re-processing.
 *
 * Run from workspace root:
 *   node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
 *     artifacts/api-server/src/scripts/rescan-pdf-all.ts
 */

import { eq, and } from "drizzle-orm";
import { db, jobsTable, jobFilesTable, extractedSignsTable } from "@workspace/db";
import { runPdfProcessor } from "../lib/pdf-processor";

async function rescanAll() {
  const jobs = await db.query.jobsTable.findMany({ columns: { id: true, name: true } });
  console.log(`Found ${jobs.length} job(s):`);
  for (const j of jobs) console.log(`  [${j.id}] ${j.name}`);

  for (const job of jobs) {
    console.log(`\n━━━ Rescanning: ${job.name} (${job.id}) ━━━`);

    // 1. Delete only PDF-sourced extracted signs for this job
    const deleted = await db
      .delete(extractedSignsTable)
      .where(
        and(
          eq(extractedSignsTable.jobId, job.id),
          eq(extractedSignsTable.dataSource, "pdf")
        )
      )
      .returning({ id: extractedSignsTable.id });
    console.log(`  Cleared ${deleted.length} PDF-sourced sign rows`);

    // 2. Reset page stats on all job files so they get fully re-classified
    await db
      .update(jobFilesTable)
      .set({ pageStats: null, pageCount: null })
      .where(eq(jobFilesTable.jobId, job.id));
    console.log(`  Reset page stats for all files`);

    // 3. Re-run the full PDF pipeline (bookmarks + classification + heuristic extraction)
    try {
      await runPdfProcessor(job.id);
      console.log(`  ✓ Done`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err}`);
    }
  }

  console.log("\n✓ All jobs rescanned.");
  process.exit(0);
}

rescanAll().catch((err) => {
  console.error("Rescan failed:", err);
  process.exit(1);
});
