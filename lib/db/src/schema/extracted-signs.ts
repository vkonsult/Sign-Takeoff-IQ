import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  boolean,
  json,
  timestamp,
  type AnyPgColumn,
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
  xPos: real("x_pos"),
  yPos: real("y_pos"),
  placementSource: text("placement_source"),
  extractionMethod: text("extraction_method").default("text"),
  // Self-referential FK: both the text and image rows of a matched pair point to each other.
  // ON DELETE SET NULL so deleting one half of a pair does not cascade-delete the other.
  pairedSignId: uuid("paired_sign_id").references(
    (): AnyPgColumn => extractedSignsTable.id,
    { onDelete: "set null" }
  ),
  adaRequired: boolean("ada_required").default(false),
  manuallyAdded: boolean("manually_added").notNull().default(false),
  manuallyEdited: boolean("manually_edited").notNull().default(false),
  userVerified: boolean("user_verified").notNull().default(false),
  hidden: boolean("hidden").notNull().default(false),
  confidenceScore: real("confidence_score").notNull().default(0),
  reviewFlag: boolean("review_flag").notNull().default(false),
  exceptionReason: text("exception_reason"),
  aiBboxX: real("ai_bbox_x"),
  aiBboxY: real("ai_bbox_y"),
  aiBboxW: real("ai_bbox_w"),
  aiBboxH: real("ai_bbox_h"),
  aiBbox: boolean("ai_bbox").notNull().default(false),
  dataSource: text("data_source").default("pdf"),
  rawJson: json("raw_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertExtractedSignSchema = createInsertSchema(extractedSignsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertExtractedSign = z.infer<typeof insertExtractedSignSchema>;
export type ExtractedSign = typeof extractedSignsTable.$inferSelect;
