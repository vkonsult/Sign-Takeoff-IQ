import { pgTable, uuid, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userRoleEnum = pgEnum("user_role", [
  "SUPER_ADMIN",
  "ADMIN",
  "SALES",
  "ESTIMATOR",
  "PROJECT_MANAGER",
]);

export const organizationsTable = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  website: text("website"),
  logoUrl: text("logo_url"),
  onboardingComplete: boolean("onboarding_complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembershipsTable = pgTable("organization_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  clerkUserId: text("clerk_user_id").notNull(),
  fullName: text("full_name"),
  email: text("email"),
  role: userRoleEnum("role").notNull().default("SALES"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;

export const insertOrganizationMembershipSchema = createInsertSchema(organizationMembershipsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOrganizationMembership = z.infer<typeof insertOrganizationMembershipSchema>;
export type OrganizationMembership = typeof organizationMembershipsTable.$inferSelect;
