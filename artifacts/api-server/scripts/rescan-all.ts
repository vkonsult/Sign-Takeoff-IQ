/**
 * Rescan all jobs with PDF-only extraction (no AI calls).
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/rescan-all.ts
 */
import { db } from "@workspace/db";
import { jobsTable } from "@workspace/db";
import { processJob } from "../src/lib/process-job";

const JOB_IDS = [
  { id: "fb807b7f-d98b-4b24-a1f9-c52a866ac453", name: "Church Plan All Pages" },
  { id: "a3336c64-965b-4a06-848e-920b2eb81ae7", name: "floor plans" },
  { id: "ba322176-b6b8-477d-bcc1-de8df1e1da71", name: "floor plans" },
  { id: "bd4b8709-d702-4bad-91f7-320a55ba8182", name: "floor plans" },
  { id: "99c638e8-29af-4d59-9ab6-36f83881a958", name: "floor plans" },
  { id: "529635a2-bee7-412f-a14b-9273e7ade30f", name: "floor plans" },
  { id: "fc1d67a5-1f4d-4c0a-96d3-cd516bc266e6", name: "Floor PlansDtc 1" },
  { id: "a5276414-6d1c-4d7f-aecb-a74829d1706b", name: "Church Plan one page" },
  { id: "220f4c9a-b779-49bd-8bdf-1571793464fc", name: "3rd Floor Union at Tower Dist" },
];

console.log(`\n=== PDF-only rescan of ${JOB_IDS.length} jobs ===\n`);

for (const { id, name } of JOB_IDS) {
  const start = Date.now();
  process.stdout.write(`[${new Date().toISOString()}] ${name.padEnd(35)} → `);
  try {
    await processJob(id);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✓ ${elapsed}s`);
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✗ ${elapsed}s — ${(err as Error).message}`);
  }
}

console.log("\n=== All done ===");
process.exit(0);
