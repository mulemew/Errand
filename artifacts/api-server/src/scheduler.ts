import { Cron } from "croner";
import { db, tasksTable, logsTable, eq, isNotNull, and, gte, lt, lte, sql } from "@workspace/db";
import { logger } from "./lib/logger";
import { runTask } from "./automation/runner";
import { purgeExpiredSessions } from "./lib/sessions";
import { loadRetentionConfig, loadTaskTimeoutConfig } from "./lib/appSettings";
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
  // A WINDOW QUOTA that resets when it is spent — the behaviour the setting describes, and
  // the one asked for: N runs inside one window; once N have happened, a fresh window starts
  // from the last of them.
  //
  // This replaces slot spacing (next = lastRun + window/N x jitter), which gets the average
  // rate right and caps nothing: "twice a month" ran every 7.5-15 days, so a month could hold
  // four runs. A quota is the only thing that makes "at most twice" true, and anchoring the
  // reset on the last run is what stops the boundary drifting.
  //
  // Derived from the run log rather than stored, so it survives restarts AND counts runs this
  // scheduler did not start — pressing Run by hand spends the quota, which is the point of
  // asking for a limit. Retries are excluded: a retry is the same run trying again, and
  // letting one consume a slot would mean two failures could quietly eat a window.

  async function scheduleWindow(): Promise<void> {
    const now = Date.now();
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    // Where the current window starts, and how much of it is spent.
    //
    // Derived by COUNTING, not by asking whether the recent runs happen to sit close
    // together. Grouping runs into consecutive chunks of N is the only reading that
    // survives a reset: run 1 and 2 belong to window 1, run 3 and 4 to window 2, and the
    // window a run OPENS is the one after the chunk it closes.
    //
    // Getting this wrong is the classic failure here and I reproduced it once already: if
    // "the last N runs fall within one window" counts as spent, then every run re-spends the
    // window and resets it, the quota never binds, and a month meant to hold two runs held
    // ten in simulation.
    let windowStartMs = now;
    let used = 0;
    let runs0Ms = 0; // the most recent run, for the minimum-gap floor below
    try {
      const [{ n }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(logsTable)
        .where(and(
          eq(logsTable.taskId, taskId),
          // A retry is the same run trying again. Letting one consume a slot would mean two
          // failures could quietly eat a window.
          sql`(${logsTable.triggeredBy} IS NULL OR ${logsTable.triggeredBy} <> 'retry')`,
        ))) as Array<{ n: number }>;
      const total = Number(n) || 0;
      if (total > 0) {
        used = total % runsPerWindow;
        // used === 0 → the window is spent; it restarts at the newest run.
        // used  >  0 → we are inside a window that opened at the run which closed the last
        //              complete chunk, i.e. the (used + 1)th most recent run.
        const back = used === 0 ? 1 : used + 1;
        const rows = await db
          .select({ runAt: logsTable.runAt })
          .from(logsTable)
          .where(and(
            eq(logsTable.taskId, taskId),
            sql`(${logsTable.triggeredBy} IS NULL OR ${logsTable.triggeredBy} <> 'retry')`,
          ))
          .orderBy(sql`${logsTable.runAt} desc`)
          .limit(back);
        const anchor = rows[rows.length - 1];
        if (anchor) windowStartMs = new Date(anchor.runAt).getTime();
        if (rows[0]) runs0Ms = new Date(rows[0].runAt).getTime();
      }
    } catch (err) {
      logger.warn({ taskId, err }, "Could not read the run history — scheduling from now");
    }

    const windowEndMs = windowStartMs + windowMs;

    // Uniform across what is LEFT of the window. Not divided among the runs still owed:
    // where they fall inside the window is not the scheduler's business — two runs landing
    // near the end of the month is a perfectly good outcome, and anyone wanting them spread
    // differently should change the window, not have density imposed here. The contract is
    // N runs inside the window, nothing about their spacing.
    const from = Math.max(now, windowStartMs);
    const span = Math.max(0, windowEndMs - from);
    let nextRunMs = from + Math.random() * span;

    // The gap has one job: do not schedule a run while the previous one can still be going.
    //
    // Two things decide how long that is, and both are knowable rather than matters of taste:
    // the run itself may occupy up to the task timeout, and a failed run then retries
    // retryCount times at retryIntervalMinutes. A run scheduled inside either stretch is
    // turned away by the "already running" guard, which costs a slot the window still owes
    // and has to squeeze in later.
    //
    // Nothing else. Spacing WITHIN the window is not a scheduling concern — two runs near
    // the end of the month is a fine outcome, and a different density is a different window.
    let minGapMs = 0;
    try {
      const [cfg] = await db
        .select({ retryCount: tasksTable.retryCount, retryIntervalMinutes: tasksTable.retryIntervalMinutes })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId));
      const timeoutCfg = await loadTaskTimeoutConfig();
      const timeoutMs = Math.max(0, Number(timeoutCfg.timeoutMinutes ?? 0)) * 60 * 1000;
      const retries = Number(cfg?.retryCount ?? 0);
      const intervalMin = Number(cfg?.retryIntervalMinutes ?? 0);
      // A retry chain is retries x interval, and each attempt can itself run to the timeout.
      const chainMs = retries > 0 && intervalMin > 0 ? retries * (intervalMin * 60 * 1000 + timeoutMs) : 0;
      minGapMs = Math.max(timeoutMs, chainMs);
    } catch (err) {
      logger.warn({ taskId, err }, "Could not read the retry/timeout settings — no minimum gap applied");
    }
    if (runs0Ms > 0) nextRunMs = Math.max(nextRunMs, runs0Ms + minGapMs);
    if (nextRunMs <= now) {
      // Overdue: the process was down, or the task was just enabled. Go soon, but not
      // instantly — a restart should not look like a trigger.
      nextRunMs = now + 5_000 + Math.random() * Math.min(windowMs * 0.05, 5 * 60 * 1000);
    }

    db.update(tasksTable).set({ nextRunAt: new Date(nextRunMs) }).where(eq(tasksTable.id, taskId)).catch(() => {});
    logger.info(
      {
        taskId,
        windowMinutes,
        runsPerWindow,
        // The window this run belongs to, and how much of its quota is already gone —
        // enough to answer "why then?" without reading the scheduler.
        windowStart: new Date(windowStartMs).toISOString(),
        windowEnd: new Date(windowEndMs).toISOString(),
        usedInWindow: used,
        minGapMinutes: Math.round(minGapMs / 60000),
        nextRunAt: new Date(nextRunMs).toISOString(),
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
