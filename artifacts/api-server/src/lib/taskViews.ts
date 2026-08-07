/**
 * Where to watch a given browser.
 *
 * Each camoufox session now gets its own Xvfb and its own websockify port, so "watch this
 * one" means proxying THAT port rather than the container-wide one. The sidecar reports the
 * port when the session launches; this remembers who it belongs to for as long as it lasts.
 *
 * Keyed by a string rather than a task id because not every browser belongs to a task: the
 * Browsers page opens sessions by hand ("bi_…"), and they need watching just as much.
 *
 * In memory and deliberately lossy: it describes a live process. A missing entry simply
 * means "no session of its own right now", and the caller falls back to the shared display.
 */
const views = new Map<string, { host: string; port: number }>();

export function setView(key: string, host: string, port: number): void {
  views.set(key, { host, port });
}

export function getView(key: string): { host: string; port: number } | undefined {
  return views.get(key);
}

export function clearView(key: string): void {
  views.delete(key);
}

/** The key a task's own session is registered under — the one key shape we mint ourselves. */
export function taskViewKey(taskId: number): string {
  return `task-${taskId}`;
}
