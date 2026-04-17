import { db } from "@workspace/db";
import { aiCallLogsTable } from "@workspace/db";
import { logger } from "./logger";

export interface AiCallEntry {
  jobId?: string | null;
  pageNumber?: number | null;
  callType: string;
  prompt: string;
  responseJson: unknown;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

let aiLogFailureCount = 0;

/**
 * Returns the total number of times logAiCall has failed to persist a row.
 * Expose via a health/metrics endpoint so operators can detect persistent
 * failures without relying solely on log scraping.
 */
export function getAiLogFailureCount(): number {
  return aiLogFailureCount;
}

/**
 * Fire-and-forget helper that inserts one row into ai_call_logs.
 * A DB failure is logged at ERROR level and counted so monitoring can surface
 * the problem. The error is still swallowed so a DB hiccup never breaks a scan.
 */
export function logAiCall(entry: AiCallEntry): void {
  db.insert(aiCallLogsTable)
    .values({
      jobId: entry.jobId ?? null,
      pageNumber: entry.pageNumber ?? null,
      callType: entry.callType,
      prompt: entry.prompt,
      responseJson: entry.responseJson as Record<string, unknown>,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      durationMs: entry.durationMs,
    })
    .catch((err: unknown) => {
      aiLogFailureCount += 1;
      logger.error(
        { err, aiLogFailureCount },
        "logAiCall: failed to insert ai_call_log (non-fatal) — audit trail may be incomplete"
      );
    });
}
