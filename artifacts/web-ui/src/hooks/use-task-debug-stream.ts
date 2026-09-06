import { useEffect, useRef, useState } from "react";

export interface DebugLine {
  /** ms since epoch */
  t: number;
  level: string;
  msg: string;
}

/** Client-side cap. The server keeps its own (smaller) ring buffer for replay. */
const MAX_LINES = 800;

/**
 * Live server log for one task.
 *
 * Opens ONLY while `enabled` is true — the connection is what tells the server somebody is
 * watching, and the server lowers its log level for exactly that long. Closing the panel
 * (or leaving the page) closes the stream and puts the level back, so this costs nothing
 * when nobody is looking.
 *
 * Nothing here is persisted anywhere: lines exist in this component's state and in the
 * server's in-memory ring buffer, and both die with the run.
 */
export function useTaskDebugStream(taskId: number, enabled: boolean) {
  const [lines, setLines] = useState<DebugLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [configuredLevel, setConfiguredLevel] = useState<string>("");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !taskId) {
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
      return;
    }

    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const es = new EventSource(`${base}/api/tasks/${taskId}/debug-stream`, { withCredentials: true });
    esRef.current = es;
    setLines([]);

    es.onopen = () => setConnected(true);
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as
          | { type: "meta"; configuredLevel: string }
          | ({ type: "line" } & DebugLine);
        if (data.type === "meta") {
          setConfiguredLevel(data.configuredLevel);
          return;
        }
        setLines((prev) => {
          const next = [...prev, { t: data.t, level: data.level, msg: data.msg }];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } catch {
        /* a malformed frame is not worth breaking the panel over */
      }
    };
    // EventSource reconnects on its own; just reflect the state.
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [taskId, enabled]);

  return { lines, connected, configuredLevel };
}
