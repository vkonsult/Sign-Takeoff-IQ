import type { Request } from "express";
import { db, activityLogsTable, jobsTable } from "@workspace/db";
import type { ActivityEventType } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export function recordActivity(
  req: Request,
  eventType: ActivityEventType,
  jobId: string,
): void {
  const user = req.authUser;
  if (!user || user.userId === "guest-super-admin") return;

  const organizationId = user.organizationId ?? null;

  db.select({ name: jobsTable.name })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1)
    .then(([job]) => {
      return db.insert(activityLogsTable).values({
        organizationId,
        userId: user.userId,
        userName: user.userName,
        userInitials: user.userInitials,
        jobId,
        jobName: job?.name ?? null,
        eventType,
      });
    })
    .catch((err) => {
      logger.warn({ err, eventType, jobId }, "Failed to record activity");
    });
}
