import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  json,
  timestamp,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { extractedSignsTable } from "./extracted-signs";
import { jobFilesTable } from "./job-files";

export const signTypeSpecsTable = pgTable("sign_type_specs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  sourceFileId: uuid("source_file_id").references(() => jobFilesTable.id, { onDelete: "set null" }),
  typeCode: text("type_code").notNull(),
  dimensions: text("dimensions"),
  material: text("material"),
  features: json("features").$type<string[]>(),
  keynoteMap: json("keynote_map").$type<Record<string, string>>(),
  cropBox: json("crop_box").$type<{ x: number; y: number; w: number; h: number; pageNum: number } | null>(),
  cropImageUrl: text("crop_image_url"),
  geminiNotes: json("gemini_notes").$type<Record<string, unknown> | null>(),
  hasDrawing: boolean("has_drawing").notNull().default(false),
  geminiEnriched: boolean("gemini_enriched").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SignTypeSpec = typeof signTypeSpecsTable.$inferSelect;
export type InsertSignTypeSpec = typeof signTypeSpecsTable.$inferInsert;

export const signageScheduleEntriesTable = pgTable("signage_schedule_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  signTypeSpecId: uuid("sign_type_spec_id").references(() => signTypeSpecsTable.id, { onDelete: "set null" }),
  pairedSignId: uuid("paired_sign_id").references(() => extractedSignsTable.id, { onDelete: "set null" }),
  sourceTableName: text("source_table_name"),
  pageNumber: integer("page_number"),
  roomNumber: text("room_number"),
  roomName: text("room_name"),
  signTypeCode: text("sign_type_code"),
  quantity: integer("quantity"),
  signageText: text("signage_text"),
  glassBacker: boolean("glass_backer"),
  rawComments: text("raw_comments"),
  expandedComments: text("expanded_comments"),
  dimensions: text("dimensions"),
  material: text("material"),
  features: json("features").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SignageScheduleEntry = typeof signageScheduleEntriesTable.$inferSelect;
export type InsertSignageScheduleEntry = typeof signageScheduleEntriesTable.$inferInsert;
