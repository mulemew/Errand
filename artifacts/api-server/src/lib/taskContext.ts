import { AsyncLocalStorage } from "async_hooks";

/**
 * Which task the current async call chain belongs to.
 *
 * The logger needs this and nothing else does: `logger.info(...)` is called from thirty
 * modules that have no idea a task exists, so the only way to route a log line to the run
 * that produced it — without threading a taskId through every signature — is to read it
 * from the ambient async context.
 *
 * Purely additive: nothing branches on it, and an empty store just means "not inside a
 * run", which is the correct answer for scheduler ticks, HTTP handlers and boot code.
 */
export const taskContext = new AsyncLocalStorage<{ taskId: number }>();

/** Run `fn` with `taskId` attached to every async call it makes. */
export function runWithTaskContext<T>(taskId: number, fn: () => T): T {
  return taskContext.run({ taskId }, fn);
}

/** The task owning the current async context, if any. */
export function currentTaskId(): number | null {
  return taskContext.getStore()?.taskId ?? null;
}
