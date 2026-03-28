import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  boolean,
  json,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { jobFilesTable } from "./job-files";

export const extractedSignsTable = pgTable("extracted_signs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  jobFileId: uuid("job_file_id").references(() => jobFilesTable.id, { onDelete: "cascade" }),
  sheetNumber: text("sheet_number"),
  detailReference: text("detail_reference"),
  signType: text("sign_type"),
  signIdentifier: text("sign_identifier"),
  quantity: integer("quantity"),
  location: text("location"),
  dimensions: text("dimensions"),
  mountingType: text("mounting_type"),
  finishColor: text("finish_color"),
  illumination: text("illumination"),
  materials: text("materials"),
  messageContent: text("message_content"),
  notes: text("notes"),
  pageNumber: integer("page_number"),
  confidenceScore: real("confidence_score").notNull().default(0),
  reviewFlag: boolean("review_flag").notNull().default(false),
  rawJson: json("raw_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertExtractedSignSchema = createInsertSchema(extractedSignsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertExtractedSign = z.infer<typeof insertExtractedSignSchema>;
export type ExtractedSign = typeof extractedSignsTable.$inferSelect;
