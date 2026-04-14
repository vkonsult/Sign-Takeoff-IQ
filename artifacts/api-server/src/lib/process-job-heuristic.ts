/**
 * Heuristic job processor — no AI calls, runs the Python-ported regex/spatial
 * algorithm (`extractSignsHeuristic`) against every uploaded PDF file.
 *
 * Mirrors the shape of `processJob` but is much simpler:
 *   • No Gemini API calls (no tokens, no rate limits)
 *   • No visual verification pass
 *   • Typically completes in 1–5 seconds regardless of PDF size
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { jobsTable, jobFilesTable, extractedSignsTable } from "@workspace/db";
import { extractSignsHeuristic } from "./extraction-heuristic";
import { deduplicateSignRows } from "./process-job";
import { saveParsedResult } from "./storage";
import { logger } from "./logger";

export async function processJobHeuristic(jobId: string): Promise<void> {
  const startTime = Date.now();

  // ── Load job + files ──────────────────────────────────────────────────────
  const job = await db.query.jobsTable.findFirst({ where: eq(jobsTable.id, jobId) });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const files = await db.query.jobFilesTable.findMany({
    where: eq(jobFilesTable.jobId, jobId),
  });

  if (files.length === 0) {
    await db.update(jobsTable).set({ status: "failed", error: "No files found", updatedAt: new Date() }).where(eq(jobsTable.id, jobId));
    return;
  }

  await db.update(jobsTable).set({ status: "processing", updatedAt: new Date() }).where(eq(jobsTable.id, jobId));
  logger.info({ jobId, fileCount: files.length }, "Heuristic job started");

  // ── Process all files in parallel ────────────────────────────────────────
  const fileResults = await Promise.all(
    files.map(async (file) => {
      try {
        const { rows, pageCount } = await extractSignsHeuristic(file.storedPath, file.id);
        await db
          .update(jobFilesTable)
          .set({ pageCount })
          .where(eq(jobFilesTable.id, file.id));
        return { ok: true as const, file, rows, pageCount };
      } catch (err) {
        logger.error({ err, fileId: file.id }, "Heuristic file extraction failed");
        return { ok: false as const, file, error: String(err) };
      }
    })
  );

  // ── Merge results ─────────────────────────────────────────────────────────
  const allInserts = [];
  const parsedResults = [];

  for (const result of fileResults) {
    if (!result.ok) {
      parsedResults.push({ fileId: result.file.id, fileName: result.file.originalName, error: result.error });
      continue;
    }
    const { file, rows, pageCount } = result;
    parsedResults.push({
      fileId: file.id,
      fileName: file.originalName,
      pageCount,
      rowCount: rows.length,
      rows,
    });
    for (const row of rows) {
      allInserts.push({
        jobId,
        jobFileId: file.id,
        ...row,
      });
    }
  }

  // ── Deduplicate + insert ──────────────────────────────────────────────────
  const deduped = deduplicateSignRows(allInserts);

  if (deduped.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < deduped.length; i += CHUNK) {
      await db.insert(extractedSignsTable).values(deduped.slice(i, i + CHUNK));
    }
  }

  // ── Save debug JSON ───────────────────────────────────────────────────────
  await saveParsedResult(jobId, { method: "heuristic", files: parsedResults }).catch(() => undefined);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  await db
    .update(jobsTable)
    .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  logger.info(
    { jobId, signsFound: deduped.length, elapsedSec: elapsed },
    "Heuristic job completed"
  );
}
