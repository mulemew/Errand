import { db, tasksTable } from "@workspace/db";

/**
 * Which tasks reference each provider / fingerprint profile / proxy profile.
 *
 * Deleting one of these is already SAFE — the delete handlers strip the id out of every
 * task's browserConfig, and the runner falls back (a missing provider drops to the default
 * one, a missing profile to the task's inline settings). What was missing is being able to
 * SEE the usage first: the pages listed profiles with no indication that something depended
 * on them, so deleting one silently reconfigured tasks you had no reason to think about.
 *
 * One query for the whole set — these lists are small and always rendered together.
 */
export type TaskRef = { id: number; name: string };

export interface UsageMaps {
  provider: Map<number, TaskRef[]>;
  fingerprint: Map<number, TaskRef[]>;
  proxy: Map<number, TaskRef[]>;
  /** Saved credentials, which are referenced by a login STEP rather than browserConfig. */
  credential: Map<number, TaskRef[]>;
}

type TaskBrowserConfig = {
  providerId?: number | null;
  fingerprintProfileId?: number | null;
  proxyProfileId?: number | null;
} | null;

export async function loadUsageMaps(): Promise<UsageMaps> {
  const maps: UsageMaps = {
    provider: new Map(),
    fingerprint: new Map(),
    proxy: new Map(),
    credential: new Map(),
  };
  const add = (map: Map<number, TaskRef[]>, id: unknown, task: TaskRef) => {
    const key = Number(id);
    if (!Number.isFinite(key) || key <= 0) return;
    const list = map.get(key);
    if (list) list.push(task);
    else map.set(key, [task]);
  };

  try {
    const rows = await db
      .select({
        id: tasksTable.id,
        name: tasksTable.name,
        browserConfig: tasksTable.browserConfig,
        steps: tasksTable.steps,
      })
      .from(tasksTable)
      .orderBy(tasksTable.name);
    for (const row of rows) {
      const task: TaskRef = { id: row.id, name: row.name };
      const bc = row.browserConfig as TaskBrowserConfig;
      if (bc) {
        add(maps.provider, bc.providerId, task);
        add(maps.fingerprint, bc.fingerprintProfileId, task);
        add(maps.proxy, bc.proxyProfileId, task);
      }
      // A task can reference several credentials — one per login step — so each is counted
      // once per task, not once per step.
      const steps = row.steps as Array<Record<string, unknown>> | null;
      if (Array.isArray(steps)) {
        const seen = new Set<number>();
        for (const st of steps) {
          const cid = Number(st?.credentialId);
          if (!Number.isFinite(cid) || cid <= 0 || seen.has(cid)) continue;
          seen.add(cid);
          add(maps.credential, cid, task);
        }
      }
    }
  } catch {
    // Usage is decoration: a failure here must never stop the list itself rendering.
  }
  return maps;
}
