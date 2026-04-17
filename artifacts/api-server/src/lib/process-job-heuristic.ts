/**
 * process-job-heuristic.ts — Phase 5 replacement shim
 *
 * The heuristic extraction algorithm (extraction-heuristic.ts) has been replaced
 * by the deterministic rule engine (rule-engine.ts) in Phase 5.
 *
 * This module now delegates to the main PDF processor which runs the rule engine.
 * The "heuristic" scan method in the UI now runs the same rule-based pipeline.
 */

import { processJob } from "./process-job";
import { logger } from "./logger";

/**
 * Process a job using the rule engine (Phase 5).
 * Previously ran extractSignsHeuristic; now delegates to the full PDF processor.
 */
export async function processJobHeuristic(jobId: string): Promise<void> {
  logger.info({ jobId }, "processJobHeuristic → delegating to rule engine (Phase 5)");
  await processJob(jobId);
}
