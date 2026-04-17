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

export const jobsTable = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  name: text("name"),
  status: jobStatusEnum("status").notNull().default("pending"),
  fileCount: integer("file_count").notNull().default(0),
  error: text("error"),
  currentStep: text("current_step"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  imageInputTokens: integer("image_input_tokens").notNull().default(0),
  imageOutputTokens: integer("image_output_tokens").notNull().default(0),
  compareTextInputTokens: integer("compare_text_input_tokens").notNull().default(0),
  compareTextOutputTokens: integer("compare_text_output_tokens").notNull().default(0),
  projectAddress: text("project_address"),
  projectCity: text("project_city"),
  projectState: text("project_state"),
  buildingType: text("building_type"),
  projectName: text("project_name"),
  jurisdiction: text("jurisdiction"),
  issueDate: text("issue_date"),
  drawingIndexPageNum: integer("drawing_index_page_num"),
  scanMethod: text("scan_method").default("gemini"),
  processingLog: json("processing_log").$type<ProcessingStep[]>(),
  plaqueTable: json("plaque_table").$type<PlaqueTableData | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface ProcessingStep {
  step: string;
  label: string;
  durationMs: number;
  startedAt: string;
  phase?: string;
  details?: Record<string, unknown>;
}

export interface PlaqueTypeRow {
  typeCode: string;
  displayName: string;
  letterHeight: string | null;
  hasBraille: boolean;
  hasInsert: boolean;
  triggerCondition: string | null;
  dimensions: string | null;
  material: string | null;
  mountingNote: string | null;
  adaNote: string | null;
  rawNote: string | null;
}

export interface PlaqueTableData {
  plaqueTypes: PlaqueTypeRow[];
  generalNotes: string[];
  sourcePages: number[];
  extractionMethod: "visual" | "text_fallback";
  warnings: string[];
}

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
