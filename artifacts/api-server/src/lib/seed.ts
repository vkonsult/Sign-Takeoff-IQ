import { db, organizationsTable, jobsTable } from "@workspace/db";
import { eq, isNull, count } from "drizzle-orm";
import { logger } from "./logger";

const DEFAULT_ORG_SLUG = "default";

export async function seedDefaultOrg(): Promise<void> {
  const [{ count: orgCount }] = await db
    .select({ count: count() })
    .from(organizationsTable);

  if (Number(orgCount) > 0) return;

  logger.info("No organizations found — seeding default organization");

  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Default",
      slug: DEFAULT_ORG_SLUG,
      onboardingComplete: true,
    })
    .returning();

  if (!org) {
    logger.error("Failed to create default organization");
    return;
  }

  const updated = await db
    .update(jobsTable)
    .set({ organizationId: org.id })
    .where(isNull(jobsTable.organizationId))
    .returning({ id: jobsTable.id });

  logger.info({ orgId: org.id, jobsAssigned: updated.length }, "Default organization seeded");
}
