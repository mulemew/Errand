import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A user-defined folder for the dashboard's task list.
 *
 * Deliberately NOT a foreign key on tasks: a group is a view-level convenience, and
 * deleting one must never risk taking tasks with it. The delete handler clears group_id
 * instead, and a task pointing at a group that no longer exists simply renders as
 * ungrouped.
 */
export const taskGroupsTable = pgTable("task_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** Position among groups. Lower first; ties fall back to id. */
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTaskGroupSchema = createInsertSchema(taskGroupsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTaskGroup = z.infer<typeof insertTaskGroupSchema>;
export type TaskGroup = typeof taskGroupsTable.$inferSelect;
