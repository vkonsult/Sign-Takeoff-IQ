import { pgTable, uuid, text, integer, timestamp, json, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";

export const jobFilesTable = pgTable("job_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  originalName: text("original_name").notNull(),
  storedPath: text("stored_path").notNull(),
  pageCount: integer("page_count"),
  extractedText: text("extracted_text"),
  pageStats: json("page_stats").$type<{
    floorPlanPages: number[];
    signSchedulePages: number[];
    bothPages?: number[];
    lifeSafetyPages?: number[];
    otherPages: number[];
    pageTypes?: Record<string, "floor_plan" | "sign_schedule" | "both" | "other">;
    pageImagePaths?: Record<string, string> | null;
    pageLabels?: (string | null)[];
    rejectedPageNumbers?: number[];
    floorPageLevels?: Record<number, string>;
    bookmarkTitles?: Record<number, string>;
    sheetManifest?: Array<{
      pdfPage: number;
      bucket: string;
      sheetTitle: string;
      sheetNumber: string | null;
      level: string | null;
      area: string | null;
      building: string | null;
      source: string;
    }>;
    outlineSections?: Array<{
      title: string;
      pageStart: number;
      pageEnd: number;
      bucket: string;
    }>;
  }>(),
  roomInventory: jsonb("room_inventory").$type<object | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobFileSchema = createInsertSchema(jobFilesTable).omit({ id: true, createdAt: true });
export type InsertJobFile = z.infer<typeof insertJobFileSchema>;
export type JobFile = typeof jobFilesTable.$inferSelect;
