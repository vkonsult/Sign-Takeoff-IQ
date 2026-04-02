import { pgTable, uuid, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const jobsTable = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  name: text("name"),
  status: jobStatusEnum("status").notNull().default("pending"),
  fileCount: integer("file_count").notNull().default(0),
  error: text("error"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  imageInputTokens: integer("image_input_tokens").notNull().default(0),
  imageOutputTokens: integer("image_output_tokens").notNull().default(0),
  compareTextInputTokens: integer("compare_text_input_tokens").notNull().default(0),
  compareTextOutputTokens: integer("compare_text_output_tokens").notNull().default(0),
  projectAddress: text("project_address"),
  projectCity: text("project_city"),
  projectState: text("project_state"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
