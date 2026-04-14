import { type InsertExtractedSign } from "@workspace/db";
import { logger } from "./logger";
import { runPdfProcessor } from "./pdf-processor";

/**
 * Deduplicates sign rows before DB insertion.
 * Key: location + signType (normalized, lowercased). Only applied when both are non-null —
 * rows missing either field are kept as-is to avoid accidental merging of unrelated signs.
 * When a duplicate pair is found, the entry with a detailReference wins; if both/neither have
 * one, the higher confidenceScore is kept.
 */
export function deduplicateSignRows(rows: InsertExtractedSign[]): InsertExtractedSign[] {
  const seenKeys = new Map<string, number>(); // composite key → index in `out`
  const out: InsertExtractedSign[] = [];

  for (const row of rows) {
    if (!row.location || !row.signType) {
      out.push(row);
      continue;
    }
    const key = `${row.location.toLowerCase().trim()}||${row.signType.toLowerCase().trim()}`;
    const existingIdx = seenKeys.get(key);
    if (existingIdx === undefined) {
      seenKeys.set(key, out.length);
      out.push(row);
    } else {
      const existing = out[existingIdx]!;
      const preferNew =
        (row.detailReference && !existing.detailReference) ||
        (!!row.detailReference === !!existing.detailReference &&
          (row.confidenceScore ?? 0) > (existing.confidenceScore ?? 0));
      if (preferNew) {
        out[existingIdx] = row;
      }
    }
  }
  return out;
}

/**
 * Process a job using only the PDF Processor (no Gemini AI calls).
 * AI sign extraction is available on-demand via the /api/jobs/:jobId/ai-scan endpoint.
 */
export async function processJob(jobId: string): Promise<void> {
  logger.info({ jobId }, "processJob → delegating to PDF Processor (no AI)");
  await runPdfProcessor(jobId);
}
