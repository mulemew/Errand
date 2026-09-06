import { Router, type IRouter } from "express";
import { db, taskGroupsTable, tasksTable, eq, asc, inArray, sql } from "@workspace/db";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

const CreateBody = z.object({ name: z.string().min(1).max(60) });
const UpdateBody = z.object({ name: z.string().min(1).max(60).optional(), sortOrder: z.number().int().optional() });

/**
 * Manual ordering of the dashboard list.
 *
 * The client sends the tasks it just rearranged, in their new order, with the group each
 * one now belongs to. Positions are rewritten wholesale for those ids rather than patched
 * individually, because a drag can move an item across a group boundary and shift
 * everything after it — sending the resulting order outright is both simpler and immune to
 * the client and server disagreeing about what "position 3" meant.
 */
const ReorderBody = z.object({
  items: z
    .array(z.object({ id: z.number().int().positive(), groupId: z.number().int().positive().nullable(), sortOrder: z.number().int() }))
    .max(2000),
});

router.get("/task-groups", async (_req, res): Promise<void> => {
  const rows = await db.select().from(taskGroupsTable).orderBy(asc(taskGroupsTable.sortOrder), asc(taskGroupsTable.id));
  res.json(rows);
});

router.post("/task-groups", async (req, res): Promise<void> => {
  const body = CreateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  // Append: one past the current maximum, so a new group lands at the bottom.
  const [{ max } = { max: 0 }] = await db
    .select({ max: sql<number>`coalesce(max(${taskGroupsTable.sortOrder}), 0)::int` })
    .from(taskGroupsTable);
  const [row] = await db.insert(taskGroupsTable).values({ name: body.data.name.trim(), sortOrder: Number(max) + 1 }).returning();
  logger.info({ id: row.id, name: row.name }, "Task group created");
  res.status(201).json(row);
});

router.put("/task-groups/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = UpdateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const update: Record<string, unknown> = {};
  if (body.data.name !== undefined) update.name = body.data.name.trim();
  if (body.data.sortOrder !== undefined) update.sortOrder = body.data.sortOrder;
  const [updated] = await db.update(taskGroupsTable).set(update).where(eq(taskGroupsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/task-groups/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  // Tasks are NEVER deleted with the group — they just become ungrouped.
  const affected = await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.groupId, id));
  await db.update(tasksTable).set({ groupId: null }).where(eq(tasksTable.groupId, id));
  await db.delete(taskGroupsTable).where(eq(taskGroupsTable.id, id));
  logger.info({ id, ungrouped: affected.length }, "Task group deleted");
  res.json({ deleted: true, ungroupedTasks: affected.length });
});

router.put("/tasks/reorder", async (req, res): Promise<void> => {
  const body = ReorderBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const items = body.data.items;
  if (items.length === 0) { res.json({ updated: 0 }); return; }

  // Drop references to groups that no longer exist rather than storing a dangling id.
  const groupIds = [...new Set(items.map((i) => i.groupId).filter((g): g is number => g != null))];
  const existing = groupIds.length
    ? new Set((await db.select({ id: taskGroupsTable.id }).from(taskGroupsTable).where(inArray(taskGroupsTable.id, groupIds))).map((g) => g.id))
    : new Set<number>();

  for (const item of items) {
    await db
      .update(tasksTable)
      .set({ sortOrder: item.sortOrder, groupId: item.groupId != null && existing.has(item.groupId) ? item.groupId : null })
      .where(eq(tasksTable.id, item.id));
  }
  res.json({ updated: items.length });
});

export default router;
