/**
 * validate-church-plan-phase2.ts
 *
 * Validates that the task-586 classification fix produces exactly 1 floor_plan
 * page and 0 signage_schedule pages when the "Church Plan All Pages" PDF is run
 * through Phase 2 classification.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/validate-church-plan-phase2.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSheetManifest } from "../src/lib/sheet-manifest.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, "../data/uploads");

// ── Find most-recent Church Plan All Pages PDF ─────────────────────────────────

function findMostRecentUpload(uploadsDir: string, pattern: RegExp): string | null {
  if (!fs.existsSync(uploadsDir)) return null;
  let best: { ts: number; filePath: string } | null = null;
  for (const jobDir of fs.readdirSync(uploadsDir)) {
    const jobPath = path.join(uploadsDir, jobDir);
    try {
      if (!fs.statSync(jobPath).isDirectory()) continue;
    } catch { continue; }
    for (const filename of fs.readdirSync(jobPath)) {
      if (!pattern.test(filename)) continue;
      const m = filename.match(/^(\d+)-/);
      const ts = m ? parseInt(m[1], 10) : 0;
      if (!best || ts > best.ts) best = { ts, filePath: path.join(jobPath, filename) };
    }
  }
  return best?.filePath ?? null;
}

const churchPlanPath = findMostRecentUpload(UPLOADS_DIR, /Church_Plan_All_Pages\.pdf$/i);

if (!churchPlanPath) {
  console.error("❌  Could not locate Church_Plan_All_Pages.pdf in uploads directory");
  console.error(`    Searched: ${UPLOADS_DIR}`);
  process.exit(1);
}

console.log(`\n=== Phase 2 Validation — Church Plan All Pages PDF ===`);
console.log(`PDF: ${churchPlanPath}`);
console.log(`Starting buildSheetManifest … (111-page PDF; may take several minutes)\n`);

const start = Date.now();
const manifest = await buildSheetManifest(churchPlanPath, "validate-church-plan-phase2");
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\nManifest built in ${elapsed}s — ${manifest.totalPages} total pages\n`);

// ── Tally buckets ──────────────────────────────────────────────────────────────

const bucketCounts: Record<string, number> = {};
for (const entry of manifest.entries) {
  bucketCounts[entry.bucket] = (bucketCounts[entry.bucket] ?? 0) + 1;
}

console.log("Bucket counts:");
for (const [bucket, count] of Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${bucket.padEnd(20)} ${count}`);
}
console.log();

// ── Inspect floor_plan and signage_schedule entries ───────────────────────────

const fpEntries = manifest.entries.filter((e) => e.bucket === "floor_plan");
const ssEntries = manifest.entries.filter((e) => e.bucket === "signage_schedule");

console.log(`floor_plan entries (${fpEntries.length}):`);
for (const e of fpEntries) {
  console.log(`  page ${e.pdfPage.toString().padStart(3)}  source=${e.source.padEnd(20)}  sheetNum=${String(e.sheetNumber ?? "—").padEnd(10)}  title="${e.sheetTitle}"`);
}
if (fpEntries.length === 0) console.log("  (none)");
console.log();

console.log(`signage_schedule entries (${ssEntries.length}):`);
for (const e of ssEntries) {
  console.log(`  page ${e.pdfPage.toString().padStart(3)}  source=${e.source.padEnd(20)}  sheetNum=${String(e.sheetNumber ?? "—").padEnd(10)}  title="${e.sheetTitle}"`);
}
if (ssEntries.length === 0) console.log("  (none)");
console.log();

// ── Assertions ────────────────────────────────────────────────────────────────

let passed = true;

if (fpEntries.length !== 1) {
  console.error(`❌  FAIL: expected 1 floor_plan page, got ${fpEntries.length}`);
  passed = false;
} else {
  console.log(`✅  PASS: exactly 1 floor_plan page`);
}

if (ssEntries.length !== 0) {
  console.error(`❌  FAIL: expected 0 signage_schedule pages, got ${ssEntries.length}`);
  passed = false;
} else {
  console.log(`✅  PASS: exactly 0 signage_schedule pages`);
}

if (manifest.warnings.length > 0) {
  console.log(`\nManifest warnings:`);
  manifest.warnings.forEach((w) => console.log(`  ⚠  ${w}`));
}

console.log();
if (passed) {
  console.log("=== All assertions passed ✅ ===\n");
  process.exit(0);
} else {
  console.log("=== Validation FAILED ❌ ===\n");
  process.exit(1);
}
