/**
 * Rescan all jobs with PDF-only extraction (no AI calls).
 * Run from project root: node artifacts/api-server/scripts/rescan-all.mjs
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the compiled dist
const require = createRequire(import.meta.url);
const distPath = path.resolve(__dirname, "../dist/index.mjs");

// We'll call the HTTP API directly since the server is already running
const BASE_URL = "http://localhost:8080";

const JOB_IDS = [
  "fb807b7f-d98b-4b24-a1f9-c52a866ac453", // Church Plan All Pages
  "a3336c64-965b-4a06-848e-920b2eb81ae7", // floor plans
  "ba322176-b6b8-477d-bcc1-de8df1e1da71", // floor plans
  "bd4b8709-d702-4bad-91f7-320a55ba8182", // floor plans
  "99c638e8-29af-4d59-9ab6-36f83881a958", // floor plans
  "529635a2-bee7-412f-a14b-9273e7ade30f", // floor plans
  "fc1d67a5-1f4d-4c0a-96d3-cd516bc266e6", // Floor PlansDtc 1
  "a5276414-6d1c-4d7f-aecb-a74829d1706b", // Church Plan one page
  "220f4c9a-b779-49bd-8bdf-1571793464fc", // 3rd Floor Union at Tower Dist
];

async function processJob(jobId, name) {
  console.log(`\n[${new Date().toISOString()}] Starting: ${name} (${jobId})`);
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-rescan": "1" },
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      console.log(`  ✓ Done in ${elapsed}s — ${data.extractedCount ?? "?"} signs`);
    } else {
      const text = await res.text().catch(() => res.statusText);
      console.log(`  ✗ HTTP ${res.status} in ${elapsed}s — ${text}`);
    }
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ✗ Error in ${elapsed}s — ${err.message}`);
  }
}

const JOB_NAMES = {
  "fb807b7f-d98b-4b24-a1f9-c52a866ac453": "Church Plan All Pages",
  "a3336c64-965b-4a06-848e-920b2eb81ae7": "floor plans",
  "ba322176-b6b8-477d-bcc1-de8df1e1da71": "floor plans",
  "bd4b8709-d702-4bad-91f7-320a55ba8182": "floor plans",
  "99c638e8-29af-4d59-9ab6-36f83881a958": "floor plans",
  "529635a2-bee7-412f-a14b-9273e7ade30f": "floor plans",
  "fc1d67a5-1f4d-4c0a-96d3-cd516bc266e6": "Floor PlansDtc 1",
  "a5276414-6d1c-4d7f-aecb-a74829d1706b": "Church Plan one page",
  "220f4c9a-b779-49bd-8bdf-1571793464fc": "3rd Floor Union at Tower Dist",
};

console.log(`Rescanning ${JOB_IDS.length} jobs (PDF-only, no AI)...\n`);

for (const id of JOB_IDS) {
  await processJob(id, JOB_NAMES[id] ?? id);
}

console.log("\nAll jobs rescanned.");
