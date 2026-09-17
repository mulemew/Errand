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

/**
 * Forget a session's view — but only if it is still the one registered.
 *
 * A task that retries stands a new session up under the SAME key, and the old session's
 * release runs afterwards. Deleting unconditionally threw away the mapping the new session
 * had just written, and the live view then had nothing to proxy: the X root window with no
 * client on it, which is the blue screen that would not go away for the rest of the run.
 *
 * The port identifies the session, so a release that names its own port cannot delete a
 * successor's. A caller with no port still clears outright — that is the shutdown path,
 * where nothing is coming after it.
 */
export function clearView(key: string, port?: number): void {
  if (port == null) { views.delete(key); return; }
  const cur = views.get(key);
  if (cur && cur.port !== port) return;   // a newer session owns this key now
  views.delete(key);
}

/** The key a task's own session is registered under — the one key shape we mint ourselves. */
export function taskViewKey(taskId: number): string {
  return `task-${taskId}`;
}
