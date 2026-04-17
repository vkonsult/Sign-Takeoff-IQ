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

/**
 * Fire-and-forget helper that inserts one row into ai_call_logs.
 * Errors are swallowed with a warning so a DB hiccup never breaks a scan.
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
      logger.warn({ err }, "logAiCall: failed to insert ai_call_log (non-fatal)");
    });
}
