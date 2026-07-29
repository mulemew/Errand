import pino from "pino";
import { currentTaskId } from "./taskContext";
import { emitTaskDebug } from "./taskEvents";

const isProduction = process.env.NODE_ENV === "production";

const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** Object payload → one short readable string. Bounded: this ends up in a browser. */
function summarise(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === "msg" || v === undefined) continue;
    let text: string;
    if (v instanceof Error) text = v.message;
    else if (typeof v === "object" && v !== null) {
      try {
        text = JSON.stringify(v);
      } catch {
        text = "[unserialisable]";
      }
    } else text = String(v);
    if (text.length > 200) text = `${text.slice(0, 200)}…`;
    parts.push(`${k}=${text}`);
    if (parts.length >= 8) break;
  }
  return parts.join(" ");
}

/**
 * Mirror every log line emitted INSIDE a task run to that task's live debug stream.
 *
 * A pino hook rather than a second stream, because the hook runs in the CALLER's async
 * context — the only place `taskContext` is readable — and because it behaves identically
 * whether or not pino is using a transport (pino-pretty in dev).
 *
 * Deliberately defensive: everything is wrapped in try/catch and the real log method is
 * always called. A bug in here must not be able to change what the server does, and no
 * task may ever fail because a line could not be forwarded to a browser.
 */
function logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number) {
  try {
    const taskId = currentTaskId();
    if (taskId != null) {
      let msg = "";
      let extra = "";
      const [first, second] = args;
      if (typeof first === "string") {
        msg = first;
      } else if (typeof first === "object" && first !== null) {
        extra = summarise(first as Record<string, unknown>);
        if (typeof second === "string") msg = second;
      }
      const line = extra ? (msg ? `${msg} — ${extra}` : extra) : msg;
      if (line) emitTaskDebug(taskId, LEVEL_NAMES[level] ?? String(level), line);
    }
  } catch {
    /* never let logging break the caller */
  }
  return method.apply(this, args as never[]);
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  hooks: { logMethod: logMethod as never },
  redact: [
    // #13 — redact passwords from request bodies so they never appear in logs
    "req.body.password",
    "req.body.currentPassword",
    "req.body.newPassword",
    // Headers that carry session tokens / credentials
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

/**
 * Temporarily lower the level while someone is watching a run.
 *
 * The point of the live view is to look at a run WITHOUT first editing the server's log
 * level. pino skips disabled levels entirely — the hook never runs for them — so while at
 * least one client is watching we drop to `debug`, and restore the configured level when
 * the last one leaves. It never RAISES the level: an instance already set to `trace` keeps
 * what it has.
 */
let savedLevel: string | null = null;
const LEVEL_ORDER = ["trace", "debug", "info", "warn", "error", "fatal"];

export function beginLiveDebug(): void {
  if (savedLevel !== null) return; // already lowered
  if (LEVEL_ORDER.indexOf(logger.level) > LEVEL_ORDER.indexOf("debug")) {
    savedLevel = logger.level;
    logger.level = "debug";
  }
}

export function endLiveDebug(): void {
  if (savedLevel === null) return;
  logger.level = savedLevel;
  savedLevel = null;
}

/** The level the server would be at with nobody watching — for the UI to display. */
export function configuredLevel(): string {
  return savedLevel ?? logger.level;
}

/**
 * Change the configured level.
 *
 * Must be used instead of assigning `logger.level` directly: while a watcher has the level
 * temporarily lowered, a plain assignment would be undone the moment that watcher leaves —
 * the save would look like it worked and then silently revert.
 */
export function setConfiguredLevel(level: string): void {
  if (savedLevel !== null) {
    savedLevel = level;
    // Keep the live view at debug while it is being watched; the new level takes over on
    // the way out.
    if (LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf("debug")) {
      logger.level = level;
      savedLevel = null;
    }
    return;
  }
  logger.level = level;
}
