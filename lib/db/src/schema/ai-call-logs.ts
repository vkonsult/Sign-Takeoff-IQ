import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";

export const aiCallLogsTable = pgTable("ai_call_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobsTable.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number"),
  callType: text("call_type").notNull(),
  prompt: text("prompt").notNull(),
  responseJson: jsonb("response_json"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_call_logs_job_id_created_at_idx").on(t.jobId, t.createdAt),
  index("ai_call_logs_call_type_idx").on(t.callType),
]);

export type AiCallLog = typeof aiCallLogsTable.$inferSelect;
