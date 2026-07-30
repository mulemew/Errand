/**
 * Where to watch a given task's browser.
 *
 * Each camoufox session now gets its own Xvfb and its own websockify port, so "watch this
 * task" means proxying THAT port rather than the container-wide one. The sidecar reports
 * the port when the session launches; this remembers which task it belongs to for as long
 * as the run lasts.
 *
 * In memory and deliberately lossy: it describes a live process. A missing entry simply
 * means "no session of its own right now", and the caller falls back to the shared display.
 */
const views = new Map<number, { host: string; port: number }>();

export function setTaskView(taskId: number, host: string, port: number): void {
  views.set(taskId, { host, port });
}

export function getTaskView(taskId: number): { host: string; port: number } | undefined {
  return views.get(taskId);
}

export function clearTaskView(taskId: number): void {
  views.delete(taskId);
}
