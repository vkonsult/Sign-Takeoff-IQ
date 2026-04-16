import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  json,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";

export const complianceEntriesTable = pgTable("compliance_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  ruleRef: text("rule_ref").notNull(),
  signType: text("sign_type").notNull(),
  qty: integer("qty").notNull().default(1),
  roomNumber: text("room_number").notNull(),
  roomName: text("room_name").notNull(),
  level: text("level").notNull(),
  pageNumber: integer("page_number").notNull(),
  coordsJson: json("coords_json").$type<{ x: number; y: number } | null>(),
  color: text("color").notNull(),
  plaqueTypeId: text("plaque_type_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertComplianceEntrySchema = createInsertSchema(complianceEntriesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertComplianceEntry = z.infer<typeof insertComplianceEntrySchema>;
export type ComplianceEntry = typeof complianceEntriesTable.$inferSelect;
