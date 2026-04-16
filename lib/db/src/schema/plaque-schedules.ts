import {
  pgTable,
  uuid,
  text,
  boolean,
  json,
  timestamp,
  integer,
  real,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";

export const plaqueSchedulesTable = pgTable("plaque_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  typeId: text("type_id").notNull(),
  name: text("name"),
  braille: boolean("braille"),
  insert: boolean("insert"),
  insertSize: text("insert_size"),
  letterHeight: text("letter_height"),
  trigger: text("trigger"),
  mapsToColumn: text("maps_to_column"),
  generalNotes: json("general_notes").$type<Record<string, unknown> | null>(),
  rawJson: json("raw_json").$type<Record<string, unknown> | null>(),
  sourcePage: integer("source_page"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PlaqueSchedule = typeof plaqueSchedulesTable.$inferSelect;
export type InsertPlaqueSchedule = typeof plaqueSchedulesTable.$inferInsert;

export const occupantLoadsTable = pgTable("occupant_loads", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  roomNum: text("room_num").notNull(),
  roomName: text("room_name"),
  occupantLoad: real("occupant_load"),
  occupancyGroup: text("occupancy_group"),
  sourcePage: integer("source_page"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OccupantLoad = typeof occupantLoadsTable.$inferSelect;
export type InsertOccupantLoad = typeof occupantLoadsTable.$inferInsert;
