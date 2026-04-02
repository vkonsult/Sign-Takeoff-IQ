import { pgTable, uuid, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { jobsTable } from "./jobs";

export const activityEventTypeEnum = pgEnum("activity_event_type", [
  "job_opened",
  "scan_run",
  "sign_updated",
  "pdf_exported",
  "xlsx_exported",
]);

export const activityLogsTable = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  userName: text("user_name").notNull(),
  userInitials: text("user_initials").notNull(),
  jobId: uuid("job_id").references(() => jobsTable.id, { onDelete: "cascade" }),
  jobName: text("job_name"),
  eventType: activityEventTypeEnum("event_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("activity_logs_job_id_created_at_idx").on(t.jobId, t.createdAt),
  index("activity_logs_org_id_created_at_idx").on(t.organizationId, t.createdAt),
  index("activity_logs_user_id_created_at_idx").on(t.userId, t.createdAt),
]);

export type ActivityLog = typeof activityLogsTable.$inferSelect;
export type ActivityEventType = typeof activityEventTypeEnum.enumValues[number];
