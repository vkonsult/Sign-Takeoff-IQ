import { pgTable, uuid, text, integer, timestamp, pgEnum, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "archived",
]);

export interface SignTypeLibraryEntry {
  type_code: string;
  description: string | null;
  dimensions: string | null;
  materials: string | null;
  has_braille: boolean | null;
  has_pictogram: boolean | null;
  is_ada_tactile: boolean | null;
  is_exterior: boolean | null;
  typical_use: string | null;
  sign_keynotes: string | null;
}

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
  scanMethod: text("scan_method").default("gemini"),
  processingLog: json("processing_log").$type<ProcessingStep[]>(),
  signTypeLibrary: json("sign_type_library").$type<SignTypeLibraryEntry[]>(),
  signTypeLibraryNotes: text("sign_type_library_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface ProcessingStep {
  step: string;
  label: string;
  durationMs: number;
  startedAt: string;
  details?: Record<string, unknown>;
}

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
