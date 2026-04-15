/**
 * Re-runs the full PDF pipeline for every job in the DB.
 * Performs a bulk pre-reset first (clear auto-extracted signs + reset page stats
 * for all jobs), then runs runPdfProcessor for each job sequentially.
 * PNGs on disk are preserved and reused (the pipeline skips re-rendering if the
 * PNG file already exists).
 *
 * Run from workspace root:
 *   node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
 *     artifacts/api-server/src/scripts/rescan-pdf-all.ts
 */

import { db, jobsTable, jobFilesTable, extractedSignsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { runPdfProcessor } from "../lib/pdf-processor";
import { logger } from "../lib/logger";

async function rescanAll() {
  const jobs = await db.query.jobsTable.findMany({ columns: { id: true, name: true } });
  console.log(`Found ${jobs.length} job(s):`);
  for (const j of jobs) console.log(`  [${j.id}] ${j.name}`);

  if (jobs.length === 0) {
    console.log("No jobs to rescan.");
    return;
  }

  // Bulk pre-reset: clear all auto-extracted signs (not user-verified, not manually added)
  console.log("\n━━━ Pre-reset: clearing auto-extracted signs and page stats ━━━");
  const deleted = await db
    .delete(extractedSignsTable)
    .where(
      and(
        eq(extractedSignsTable.userVerified, false),
        eq(extractedSignsTable.manuallyAdded, false),
      ),
    )
    .returning({ id: extractedSignsTable.id });
  console.log(`  Deleted ${deleted.length} auto-extracted sign(s)`);

  // Bulk reset page_stats and page_count on all job files
  await db
    .update(jobFilesTable)
    .set({ pageStats: null, pageCount: null });
  console.log(`  Reset page_stats/page_count on all job files`);

  // Mark all jobs as processing
  await db
    .update(jobsTable)
    .set({ status: "processing", updatedAt: new Date() });
  console.log(`  Marked all ${jobs.length} job(s) as 'processing'`);

  // Process each job sequentially
  console.log("\n━━━ Starting sequential processing ━━━");
  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    console.log(`\n━━━ Rescanning: ${job.name} (${job.id}) ━━━`);
    try {
      await runPdfProcessor(job.id);
      console.log(`  ✓ Done: ${job.name}`);
      succeeded++;
    } catch (err) {
      console.error(`  ✗ Failed: ${job.name}: ${err}`);
      failed++;
      // Ensure the job is not left stuck in 'processing' if runPdfProcessor threw
      try {
        const errMsg = err instanceof Error ? err.message : String(err);
        await db
          .update(jobsTable)
          .set({ status: "failed", error: errMsg, updatedAt: new Date() })
          .where(eq(jobsTable.id, job.id));
      } catch (updateErr) {
        console.error(`  ✗ Also failed to mark job as failed in DB: ${updateErr}`);
      }
    }
  }

  console.log(`\n✓ All jobs rescanned. ${succeeded} succeeded, ${failed} failed.`);

  // Flush pino async transport before exiting so all log lines reach stdout
  // and any in-flight DB writes tied to the logger pipeline complete.
  await logger.flush();
  // Small grace period for the event loop to drain remaining I/O
  await new Promise((r) => setTimeout(r, 1500));
}

rescanAll().catch((err) => {
  console.error("Rescan failed:", err);
  process.exit(1);
});
