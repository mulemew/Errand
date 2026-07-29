import { EventEmitter } from "events";

  export interface TaskStreamEvent {
    type: "progress" | "done" | "screenshot";
    message: string;
    success?: boolean;
    screenshotPath?: string;
  }

  const emitters = new Map<number, EventEmitter>();
  const emitterCreatedAt = new Map<number, number>();

  // Replay buffer — stores recent events per task so SSE clients that connect
  // after a task has already fired steps (e.g. cron-triggered tasks) can catch up.
  const MAX_BUFFER_EVENTS = 200;
  const eventBuffers = new Map<number, TaskStreamEvent[]>();

  // Periodic sweep removes emitters/buffers not cleaned up by emitTaskDone (TTL 2 h).
  const EMITTER_TTL_MS = 2 * 60 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - EMITTER_TTL_MS;
    for (const [taskId, createdAt] of emitterCreatedAt) {
      if (createdAt < cutoff) {
        emitters.delete(taskId);
        emitterCreatedAt.delete(taskId);
        eventBuffers.delete(taskId);
        debugBuffers.delete(taskId);
        debugEmitters.delete(taskId);
      }
    }
    // Debug lines can also arrive AFTER a run finishes — a child process or a listener
    // registered during the run still carries its async context — which re-creates a
    // buffer for a task nobody will ever read. Anything without a live emitter is dead.
    for (const taskId of debugBuffers.keys()) {
      if (!emitterCreatedAt.has(taskId)) {
        debugBuffers.delete(taskId);
        debugEmitters.delete(taskId);
      }
    }
  }, 30 * 60 * 1000).unref();

  export function getTaskEmitter(taskId: number): EventEmitter {
    let em = emitters.get(taskId);
    if (!em) {
      em = new EventEmitter();
      em.setMaxListeners(30);
      emitters.set(taskId, em);
      emitterCreatedAt.set(taskId, Date.now());
    }
    return em;
  }

  function pushToBuffer(taskId: number, event: TaskStreamEvent): void {
    let buf = eventBuffers.get(taskId);
    if (!buf) {
      buf = [];
      eventBuffers.set(taskId, buf);
    }
    buf.push(event);
    if (buf.length > MAX_BUFFER_EVENTS) buf.shift();
  }

  /** Returns a snapshot of buffered events for this task (for SSE replay on connect). */
  export function getTaskEventBuffer(taskId: number): TaskStreamEvent[] {
    return eventBuffers.get(taskId) ?? [];
  }

  /** Clear the replay buffer — call at the start of every new run to discard stale events. */
  export function clearTaskEventBuffer(taskId: number): void {
    eventBuffers.delete(taskId);
    debugBuffers.delete(taskId);
  }

  export function emitTaskProgress(taskId: number, message: string): void {
    const event: TaskStreamEvent = { type: "progress", message };
    pushToBuffer(taskId, event);
    getTaskEmitter(taskId).emit("event", event);
  }

  export function emitTaskDone(taskId: number, success: boolean, message: string): void {
    const event: TaskStreamEvent = { type: "done", success, message };
    pushToBuffer(taskId, event);
    getTaskEmitter(taskId).emit("event", event);
    // Clean up 60 s after done so any in-flight SSE clients can drain their buffers
    setTimeout(() => {
      emitters.delete(taskId);
      emitterCreatedAt.delete(taskId);
      eventBuffers.delete(taskId);
      debugBuffers.delete(taskId);
      debugEmitters.delete(taskId);
    }, 60_000);
  }

  // ── Live debug log ────────────────────────────────────────────────────────────
  //
  // A SEPARATE channel from the progress events above, on purpose. Progress events are
  // the run's story (they are replayed into the timeline and capped at 200); debug lines
  // are the server's own log for that run, and there can be hundreds of them. Sharing one
  // buffer would let a chatty run push the actual progress events out of the replay window.
  //
  // Nothing here is persisted: lines live in a small ring buffer and die with the run.

  export interface TaskDebugLine {
    /** ms since epoch */
    t: number;
    /** pino level name: trace | debug | info | warn | error | fatal */
    level: string;
    msg: string;
  }

  const MAX_DEBUG_LINES = 400;
  const debugBuffers = new Map<number, TaskDebugLine[]>();
  const debugEmitters = new Map<number, EventEmitter>();

  /** Number of SSE clients currently watching each task's debug stream. */
  const debugWatchers = new Map<number, number>();

  export function getTaskDebugEmitter(taskId: number): EventEmitter {
    let em = debugEmitters.get(taskId);
    if (!em) {
      em = new EventEmitter();
      em.setMaxListeners(30);
      debugEmitters.set(taskId, em);
    }
    return em;
  }

  export function getTaskDebugBuffer(taskId: number): TaskDebugLine[] {
    return debugBuffers.get(taskId) ?? [];
  }

  /**
   * Record one log line for a task. Called from the logger's hook, so it must never throw
   * and must stay cheap — it runs on every log call inside a run.
   */
  export function emitTaskDebug(taskId: number, level: string, msg: string): void {
    try {
      const line: TaskDebugLine = { t: Date.now(), level, msg };
      let buf = debugBuffers.get(taskId);
      if (!buf) {
        buf = [];
        debugBuffers.set(taskId, buf);
      }
      buf.push(line);
      if (buf.length > MAX_DEBUG_LINES) buf.shift();
      const em = debugEmitters.get(taskId);
      if (em) em.emit("line", line);
    } catch {
      /* logging must never be able to break a run */
    }
  }

  /** True while at least one client is watching any task's debug stream. */
  export function hasDebugWatchers(): boolean {
    for (const n of debugWatchers.values()) if (n > 0) return true;
    return false;
  }

  export function addDebugWatcher(taskId: number): void {
    debugWatchers.set(taskId, (debugWatchers.get(taskId) ?? 0) + 1);
  }

  export function removeDebugWatcher(taskId: number): void {
    const n = (debugWatchers.get(taskId) ?? 1) - 1;
    if (n <= 0) debugWatchers.delete(taskId);
    else debugWatchers.set(taskId, n);
  }

  /** Drop a finished run's lines. Called alongside the progress buffer cleanup. */
  export function clearTaskDebugBuffer(taskId: number): void {
    debugBuffers.delete(taskId);
    debugEmitters.delete(taskId);
  }
