/**
 * Re-runs the full PDF pipeline for every job in the DB.
 * runPdfProcessor handles clearing old signs and resetting page stats internally.
 *
 * Run from workspace root:
 *   node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
 *     artifacts/api-server/src/scripts/rescan-pdf-all.ts
 */

import { db, jobsTable } from "@workspace/db";
import { runPdfProcessor } from "../lib/pdf-processor";

async function rescanAll() {
  const jobs = await db.query.jobsTable.findMany({ columns: { id: true, name: true } });
  console.log(`Found ${jobs.length} job(s):`);
  for (const j of jobs) console.log(`  [${j.id}] ${j.name}`);

  for (const job of jobs) {
    console.log(`\n━━━ Rescanning: ${job.name} (${job.id}) ━━━`);
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
