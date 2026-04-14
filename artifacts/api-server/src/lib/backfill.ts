import { db, jobsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export async function backfillCompletedAt(): Promise<void> {
  try {
    const result = await db
      .update(jobsTable)
      .set({ completedAt: sql`updated_at` })
      .where(
        sql`${jobsTable.status} = 'completed' AND ${jobsTable.completedAt} IS NULL`
      )
      .returning({ id: jobsTable.id });

    if (result.length > 0) {
      logger.info({ count: result.length }, "Backfilled completedAt for existing completed jobs");
    }
  } catch (err) {
    logger.error({ err }, "Failed to backfill completedAt");
  }
}
