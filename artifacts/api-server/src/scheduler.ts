import { Cron } from "croner";
import { db, tasksTable, logsTable, eq, isNotNull, and, gte, lt, lte, sql } from "@workspace/db";
import { logger } from "./lib/logger";
import { runTask } from "./automation/runner";
import { purgeExpiredSessions } from "./lib/sessions";
import { loadRetentionConfig } from "./lib/appSettings";
import path from "path";
import fs from "fs";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");

const scheduledJobs = new Map<number, Cron>();
const randomScheduleTimeouts = new Map<number, ReturnType<typeof setTimeout>[]>();

export function getScheduledJobsCount(): number {
  return scheduledJobs.size + randomScheduleTimeouts.size;
}

function parseRandomSchedule(expression: string): { windowMinutes: number; runsPerWindow: number } | null {
  if (!expression.startsWith("@random:")) return null;
  const parts = expression.split(":");
  const windowMinutes = parseInt(parts[1] ?? "", 10);
  const runsPerWindow = parseInt(parts[2] ?? "", 10);
  if (isNaN(windowMinutes) || windowMinutes < 1 || isNaN(runsPerWindow) || runsPerWindow < 1) return null;
  return { windowMinutes, runsPerWindow };
}

function parseAfterCompletionSchedule(expression: string): number | null {
  if (!expression.startsWith("@after_completion:")) return null;
  const minutes = parseInt(expression.slice("@after_completion:".length), 10);
  if (isNaN(minutes) || minutes < 1) return null;
  return minutes;
}

function formatIntervalLabel(totalMinutes: number): string {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

/**
 * Seed next_run_at for an @after_completion task, from NOW.
 *
 * "Now" is deliberate, and it is not the same base the runner uses. This function only runs
 * when there is no pending next run to preserve — the task was just enabled, edited, or the
 * server restarted — and in those cases the intended behaviour is that the clock STARTS
 * OVER: enabling a task means "begin the interval now", not "honour an interval that
 * elapsed while it was switched off" (which would fire it immediately on enable).
 *
 * The completion-driven seed lives in the runner (schedulePostCompletionIfNeeded) and is
 * based on the moment the run finished — that is the one that keeps a normally-running
 * task exactly one interval apart.
 */
function scheduleNextRunAfterCompletion(taskId: number, delayMinutes: number): void {
  const nextRunAt = new Date(Date.now() + delayMinutes * 60 * 1000);
  db.update(tasksTable).set({ nextRunAt }).where(eq(tasksTable.id, taskId)).catch(() => {});
  logger.info({ taskId, delayMinutes, nextRunAt: nextRunAt.toISOString() }, "Post-completion next run seeded");
}

export function describeScheduleExpression(expression: string | null | undefined): string | null {
  if (!expression) return null;
  const random = parseRandomSchedule(expression);
  if (random) return `Every ${formatIntervalLabel(random.windowMinutes)} for ${random.runsPerWindow} run${random.runsPerWindow === 1 ? "" : "s"}`;
  const afterCompletion = parseAfterCompletionSchedule(expression);
  if (afterCompletion !== null) return `Run again ${formatIntervalLabel(afterCompletion)} after completion`;
  return expression;
}

export async function initScheduler(): Promise<void> {
  logger.info("Initializing task scheduler");

  try {
    const result = await db
      .update(tasksTable).set({ status: "failed" })
      .where(eq(tasksTable.status, "running"))
      .returning({ id: tasksTable.id });
    if (result.length > 0) {
      logger.warn({ count: result.length, ids: result.map((r: { id: number }) => r.id) }, "Reset interrupted tasks to 'failed'");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to reset interrupted running tasks on startup");
  }

  const tasks = await db.select().from(tasksTable)
    .where(and(isNotNull(tasksTable.cronExpression), eq(tasksTable.enabled, true)));

  for (const task of tasks) {
    if (task.cronExpression) scheduleTask(task.id, task.cronExpression);
  }

  logger.info({ count: scheduledJobs.size + randomScheduleTimeouts.size }, "Scheduler initialized");

  // Trigger any @after_completion: tasks whose nextRunAt was missed during downtime
  try {
    const overdueTasks = await db.select().from(tasksTable)
      .where(and(eq(tasksTable.enabled, true), isNotNull(tasksTable.nextRunAt)));
    for (const task of overdueTasks) {
      if (!task.cronExpression || parseAfterCompletionSchedule(task.cronExpression) === null) continue;
      if (!task.nextRunAt || task.nextRunAt > new Date()) continue;
      logger.info({ taskId: task.id }, "Triggering overdue post-completion task on startup");
      await db.update(tasksTable).set({ nextRunAt: null }).where(eq(tasksTable.id, task.id));
      runTask(task.id, false, "cron").catch((err: unknown) => logger.error({ taskId: task.id, err }, "Overdue post-completion task failed"));
    }
  } catch (err) {
    logger.warn({ err }, "Failed to check overdue post-completion tasks on startup");
  }

  // Fire any auto-retries whose retry_at was missed during downtime (all schedule types).
  try {
    const now = new Date();
    const overdueRetries = await db.select().from(tasksTable)
      .where(and(eq(tasksTable.enabled, true), isNotNull(tasksTable.retryAt), lte(tasksTable.retryAt, now)));
    for (const task of overdueRetries) {
      logger.info({ taskId: task.id }, "Triggering overdue auto-retry on startup");
      await db.update(tasksTable).set({ retryAt: null }).where(eq(tasksTable.id, task.id));
      runTask(task.id, false, "retry").catch((err: unknown) => logger.error({ taskId: task.id, err }, "Overdue retry run failed"));
    }
  } catch (err) {
    logger.warn({ err }, "Failed to check overdue retries on startup");
  }

  // Polling loop: every 30 s fire (a) @after_completion next runs and (b) auto-retries.
  setInterval(async () => {
    try {
      const now = new Date();
      // (a) @after_completion interval runs — driven by next_run_at.
      const due = await db.select().from(tasksTable)
        .where(and(eq(tasksTable.enabled, true), isNotNull(tasksTable.nextRunAt), lte(tasksTable.nextRunAt, now)));
      for (const task of due) {
        if (!task.cronExpression || parseAfterCompletionSchedule(task.cronExpression) === null) continue;
        await db.update(tasksTable).set({ nextRunAt: null }).where(eq(tasksTable.id, task.id));
        logger.info({ taskId: task.id }, "Post-completion interval task triggered");
        runTask(task.id, false, "cron").catch((err: unknown) => logger.error({ taskId: task.id, err }, "Post-completion task run failed"));
      }
      // (b) Auto-retries — a DEDICATED channel (retry_at) so retry fires for EVERY schedule
      // type identically (cron, @random, @after_completion, manual), without colliding with
      // that type's own next_run_at scheduling.
      const retries = await db.select().from(tasksTable)
        .where(and(eq(tasksTable.enabled, true), isNotNull(tasksTable.retryAt), lte(tasksTable.retryAt, now)));
      for (const task of retries) {
        await db.update(tasksTable).set({ retryAt: null }).where(eq(tasksTable.id, task.id));
        logger.info({ taskId: task.id }, "Auto-retry fired");
        // Labelled "retry", not "cron": a @random task counts its runs from the log table,
        // so an attempt that only happened because the previous one FAILED must not eat
        // that window's quota (two failures + retries could silently consume a whole
        // window's worth of scheduled runs).
        runTask(task.id, false, "retry").catch((err: unknown) => logger.error({ taskId: task.id, err }, "Retry run failed"));
      }
    } catch (err) {
      logger.error({ err }, "Scheduler poll error");
    }
  }, 30_000).unref();

  // Daily session purge
  new Cron("0 3 * * *", async () => {
    logger.info("Running daily expired session purge");
    await purgeExpiredSessions();
  });

  // Daily retention cleanup
  new Cron("30 3 * * *", async () => {
    logger.info("Running daily retention cleanup");
    await runRetentionCleanup();
  });
}

/** Delete old logs and screenshots based on retention config. */
export async function runRetentionCleanup(): Promise<void> {
  try {
    const config = await loadRetentionConfig();

    // Delete old log rows
    if (config.logRetentionDays > 0) {
      const cutoff = new Date(Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000);
      const deleted = await db.delete(logsTable)
        .where(lt(logsTable.runAt, cutoff))
        .returning({ id: logsTable.id });
      if (deleted.length > 0) logger.info({ count: deleted.length, cutoff }, "Deleted old log rows");
    }

    // Enforce screenshot disk size limit
    if (config.maxScreenshotsMb > 0) {
      await enforceScreenshotSizeLimit(config.maxScreenshotsMb);
    }
  } catch (err) {
    logger.error({ err }, "Retention cleanup failed");
  }
}

async function enforceScreenshotSizeLimit(maxMb: number): Promise<void> {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return;
    const maxBytes = maxMb * 1024 * 1024;
    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => {
        const fp = path.join(SCREENSHOTS_DIR, f);
        return { name: f, path: fp, mtime: fs.statSync(fp).mtimeMs, size: fs.statSync(fp).size };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    let totalBytes = files.reduce((s, f) => s + f.size, 0);
    let removed = 0;
    for (const file of files) {
      if (totalBytes <= maxBytes) break;
      fs.unlinkSync(file.path);
      totalBytes -= file.size;
      removed++;
    }
    if (removed > 0) logger.info({ removed, maxMb }, "Removed old screenshots to enforce size limit");
  } catch (err) {
    logger.error({ err }, "Screenshot size enforcement failed");
  }
}

/**
 * setTimeout, but for delays a browser-era 32-bit millisecond counter cannot hold.
 *
 * Node stores the delay in a signed 32-bit int: anything above 2147483647 ms (24.8 days)
 * OVERFLOWS and the timer fires almost immediately. A "2 runs per 30 days" schedule
 * therefore did not wait 30 days — it fired at once, ran, re-armed, overflowed again, and
 * ran continuously. This is the "30天两次却不停地执行" report, and no amount of window
 * arithmetic above it could have helped.
 *
 * Chunking keeps each hop inside the range and re-arms until the real deadline.
 */
const MAX_TIMEOUT_MS = 2_147_483_000;

function setLongTimeout(fn: () => void, delayMs: number, sink: ReturnType<typeof setTimeout>[]): void {
  if (delayMs <= MAX_TIMEOUT_MS) {
    sink.push(setTimeout(fn, Math.max(0, delayMs)));
    return;
  }
  sink.push(setTimeout(() => setLongTimeout(fn, delayMs - MAX_TIMEOUT_MS, sink), MAX_TIMEOUT_MS));
}

function clearRandomTimeouts(taskId: number): void {
  const existing = randomScheduleTimeouts.get(taskId);
  if (existing) { existing.forEach(clearTimeout); randomScheduleTimeouts.delete(taskId); }
}

function scheduleRandomTask(taskId: number, windowMinutes: number, runsPerWindow: number): void {
  clearRandomTimeouts(taskId);
  const windowMs = windowMinutes * 60 * 1000;
  // "N runs per window" is really "one run every window/N, give or take". Scheduling by SLOT
  // rather than by window quota is what makes that true.
  //
  // The old code anchored a window to the last run, counted the runs already inside it, and
  // spread the remainder uniformly across whatever was left. Two things went wrong:
  //
  //   • the anchor run itself sat inside its own window and used up a slot, so every run
  //     reset the quota — the rate was never actually limited
  //   • once the quota was met it waited for the window to end and then picked uniformly
  //     across the NEXT full window, so the expected gap was 1.5x the window and the worst
  //     case 2x. "Every 90 minutes" ran roughly every 135, sometimes 180 — the doubling
  //     that got reported.
  //
  // One run at a time, at lastRun + slot * uniform(0.5, 1.5): the mean gap is exactly the
  // slot, the spread is still unpredictable, and no run can be more than 1.5 slots after
  // the one before it.
  const slotMs = windowMs / Math.max(1, runsPerWindow);

  async function scheduleWindow(): Promise<void> {
    const now = Date.now();
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    let lastRunMs = 0;
    try {
      const [lastRun] = await db
        .select({ runAt: logsTable.runAt })
        .from(logsTable)
        .where(and(
          eq(logsTable.taskId, taskId),
          // A retry is not a scheduled run; letting one reset the clock would push the
          // real schedule back every time a run failed.
          sql`(${logsTable.triggeredBy} IS NULL OR ${logsTable.triggeredBy} <> 'retry')`,
        ))
        .orderBy(sql`${logsTable.runAt} desc`)
        .limit(1);
      lastRunMs = lastRun ? new Date(lastRun.runAt).getTime() : 0;
    } catch (err) {
      logger.warn({ taskId, err }, "Could not read the last run — scheduling from now");
    }

    const jitter = 0.5 + Math.random(); // uniform in [0.5, 1.5) — mean 1
    let nextRunMs = lastRunMs > 0 ? lastRunMs + slotMs * jitter : now + Math.random() * slotMs;
    if (nextRunMs <= now) {
      // Overdue: the process was down, or the task was just enabled. Go soon, but not
      // instantly — a restart should not look like a trigger.
      nextRunMs = now + 5_000 + Math.random() * Math.min(slotMs * 0.25, 5 * 60 * 1000);
    }

    // ── The quota, which the slot spacing alone does not enforce ──────────────
    //
    // Slots give the right AVERAGE rate and pleasant spacing, and that is all they give.
    // "30 hours, twice" also means at most twice in any 30 hours, and runs that did not come
    // from this scheduler — you pressing run — are still runs. Two manual ones and the next
    // slot lands 16 hours out, inside a window that has already been spent.
    //
    // So: if the window already holds its full quota, the earliest the next run may happen is
    // when the OLDEST of those falls out of it. A sliding window, which is what the setting
    // reads like, and which cannot drift the way a fixed one does.
    //
    // The two are complementary, not alternatives — the reason the previous quota attempt was
    // removed was that it REPLACED the spacing (waiting for the window to end and then
    // picking uniformly across the next one, mean gap 1.5x window: the "runs every 135
    // minutes instead of 90" report). This one is only ever a floor.
    let quotaFloorMs = 0;
    try {
      const recent = await db
        .select({ runAt: logsTable.runAt })
        .from(logsTable)
        .where(and(
          eq(logsTable.taskId, taskId),
          sql`(${logsTable.triggeredBy} IS NULL OR ${logsTable.triggeredBy} <> 'retry')`,
          gte(logsTable.runAt, new Date(now - windowMs)),
        ))
        .orderBy(sql`${logsTable.runAt} desc`)
        .limit(runsPerWindow);
      if (recent.length >= runsPerWindow) {
        const oldestInQuota = new Date(recent[recent.length - 1]!.runAt).getTime();
        quotaFloorMs = oldestInQuota + windowMs;
      }
    } catch (err) {
      logger.warn({ taskId, err }, "Could not count runs in the window — scheduling on slot spacing alone");
    }
    const heldBackByQuota = quotaFloorMs > nextRunMs;
    if (heldBackByQuota) nextRunMs = quotaFloorMs;

    db.update(tasksTable).set({ nextRunAt: new Date(nextRunMs) }).where(eq(tasksTable.id, taskId)).catch(() => {});
    logger.info(
      {
        taskId,
        windowMinutes,
        runsPerWindow,
        slotMinutes: Math.round(slotMs / 60000),
        nextRunAt: new Date(nextRunMs).toISOString(),
        // Says WHY, so "why is it 16 hours and not 22" is answerable from the log rather
        // than by reading the scheduler.
        heldBackByQuota: heldBackByQuota || undefined,
      },
      "Random-interval task scheduled",
    );

    setLongTimeout(
      () => {
        void (async () => {
          try {
            const [task] = await db
              .select({ enabled: tasksTable.enabled, cronExpression: tasksTable.cronExpression })
              .from(tasksTable)
              .where(eq(tasksTable.id, taskId));
            if (!task?.enabled || !task.cronExpression || !parseRandomSchedule(task.cronExpression)) {
              randomScheduleTimeouts.delete(taskId);
              return;
            }
            logger.info({ taskId, windowMinutes, runsPerWindow }, "Random-interval task run triggered");
            await runTask(taskId, false, "cron");
          } catch (err) {
            logger.error({ taskId, err }, "Random-interval task run failed");
          } finally {
            // Re-arm from the run that just happened, whatever its outcome.
            scheduleWindow().catch((err: unknown) => logger.error({ taskId, err }, "scheduleWindow error"));
          }
        })();
      },
      nextRunMs - now,
      timeouts,
    );

    randomScheduleTimeouts.set(taskId, timeouts);
  }

  scheduleWindow().catch((err: unknown) => logger.error({ taskId, err }, "scheduleWindow initial error"));
}

export function scheduleTask(taskId: number, expression: string): void {
  unscheduleTask(taskId);
  const randomParams = parseRandomSchedule(expression);
  if (randomParams) { scheduleRandomTask(taskId, randomParams.windowMinutes, randomParams.runsPerWindow); return; }
  // @after_completion: tasks run via nextRunAt polling — no Cron job needed.
  // Seed nextRunAt immediately so the "next run" countdown shows up as soon as
  // the schedule is saved, instead of only appearing after the first manual run.
  const afterCompletionMinutes = parseAfterCompletionSchedule(expression);
  if (afterCompletionMinutes !== null) {
    logger.info({ taskId, expression }, "Post-completion interval task registered (driven by poller)");
    (async () => {
      try {
        const [t] = await db
          .select({ enabled: tasksTable.enabled, nextRunAt: tasksTable.nextRunAt })
          .from(tasksTable)
          .where(eq(tasksTable.id, taskId));
        // Only seed when enabled and no pending run is already scheduled.
        if (t?.enabled && !t.nextRunAt) {
          scheduleNextRunAfterCompletion(taskId, afterCompletionMinutes);
        }
      } catch (err) {
        logger.warn({ taskId, err }, "Failed to seed post-completion nextRunAt");
      }
    })();
    return;
  }

  // Validate by trying to construct a Cron — throws on invalid expression.
  try {
    const test = new Cron(expression);
    test.stop();
  } catch {
    logger.warn({ taskId, expression }, "Invalid cron expression, skipping schedule");
    return;
  }

  const job = new Cron(expression, async () => {
    try {
      logger.info({ taskId }, "Cron-triggered task run");
      const [t] = await db.select({ enabled: tasksTable.enabled }).from(tasksTable).where(eq(tasksTable.id, taskId));
      if (!t?.enabled) { logger.info({ taskId }, "Skipping disabled task"); return; }
      await runTask(taskId, false, "cron");
    } catch (err) {
      logger.error({ taskId, err }, "Cron job execution failed");
    }
  });

  scheduledJobs.set(taskId, job);
  logger.info({ taskId, expression, nextRun: job.nextRun()?.toISOString() }, "Task scheduled");
}

export function unscheduleTask(taskId: number): void {
  const existing = scheduledJobs.get(taskId);
  if (existing) { existing.stop(); scheduledJobs.delete(taskId); logger.info({ taskId }, "Task unscheduled"); }
  clearRandomTimeouts(taskId);
}

export function rescheduleTask(taskId: number, cronExpression: string | null | undefined): void {
  if (cronExpression) scheduleTask(taskId, cronExpression);
  else unscheduleTask(taskId);
}
