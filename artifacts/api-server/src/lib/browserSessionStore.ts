import { db, browserSessionsTable, sessionProfilesTable, eq, and } from "@workspace/db";
import { encrypt, decrypt } from "./encryption";
import { logger } from "./logger";

/**
 * Persistent per-task browser session store (cookie mode).
 *
 * Stores the Playwright storage state (cookies + localStorage) encrypted so that
 * a task can restore its logged-in session on the next run instead of logging in
 * again. Keyed by (taskId, sessionKey) — sessionKey defaults to "default" and
 * lets a single task keep multiple isolated sessions if needed.
 */

const DEFAULT_KEY = "default";

/** Load and decrypt a saved storage state, or null if none exists. */
export async function loadBrowserSession(
  taskId: number,
  sessionKey: string = DEFAULT_KEY,
): Promise<unknown | null> {
  try {
    const [row] = await db
      .select()
      .from(browserSessionsTable)
      .where(
        and(
          eq(browserSessionsTable.taskId, taskId),
          eq(browserSessionsTable.sessionKey, sessionKey),
        ),
      );
    if (!row) return null;
    const raw = (row.storageState as { enc?: string } | null)?.enc;
    if (!raw) return null;
    return JSON.parse(decrypt(raw));
  } catch (err) {
    logger.warn({ taskId, sessionKey, err }, "Failed to load browser session");
    return null;
  }
}

/** Encrypt and upsert a storage state for a task. */
export async function saveBrowserSession(
  taskId: number,
  storageState: unknown,
  sessionKey: string = DEFAULT_KEY,
): Promise<void> {
  try {
    const enc = encrypt(JSON.stringify(storageState));
    await db
      .insert(browserSessionsTable)
      .values({ taskId, sessionKey, storageState: { enc } })
      .onConflictDoUpdate({
        target: [browserSessionsTable.taskId, browserSessionsTable.sessionKey],
        set: { storageState: { enc }, updatedAt: new Date() },
      });
    logger.info({ taskId, sessionKey }, "Browser session persisted");
  } catch (err) {
    logger.warn({ taskId, sessionKey, err }, "Failed to save browser session");
  }
}

/** Delete a task's saved session(s). Used for session isolation / reset. */
export async function clearBrowserSession(
  taskId: number,
  sessionKey?: string,
): Promise<void> {
  try {
    if (sessionKey) {
      await db
        .delete(browserSessionsTable)
        .where(
          and(
            eq(browserSessionsTable.taskId, taskId),
            eq(browserSessionsTable.sessionKey, sessionKey),
          ),
        );
    } else {
      await db
        .delete(browserSessionsTable)
        .where(eq(browserSessionsTable.taskId, taskId));
    }
  } catch (err) {
    logger.warn({ taskId, sessionKey, err }, "Failed to clear browser session");
  }
}

/** Whether a task has any login step with cookie mode enabled. */
export function taskUsesCookieMode(steps: unknown): {
  enabled: boolean;
  sessionKey: string;
} {
  if (!Array.isArray(steps)) return { enabled: false, sessionKey: DEFAULT_KEY };
  for (const s of steps as Array<Record<string, unknown>>) {
    // loginMethod "cookie" (no automated login — cookies only) implies cookie mode.
    if (s && s.type === "login" && (s.cookieMode === true || s.loginMethod === "cookie")) {
      const key =
        typeof s.sessionKey === "string" && s.sessionKey.trim()
          ? s.sessionKey.trim()
          : DEFAULT_KEY;
      return { enabled: true, sessionKey: key };
    }
  }
  return { enabled: false, sessionKey: DEFAULT_KEY };
}

/**
 * A named session profile — one captured by hand on the Browsers page.
 *
 * Same storage shape as a task's own saved session, so the runner can seed a context with
 * either. Kept separate because the two answer different questions: a task's session is
 * "what this task last logged in as", a profile is "an identity you prepared deliberately".
 */
/**
 * Write a session back into the profile it came from.
 *
 * The other half of loadSessionProfile, and what makes a saved profile behave like a
 * browser you closed rather than a snapshot you took once: open it, log in, do whatever a
 * site needs, close it — and the cookies you ended up with are the ones you get next time.
 *
 * Only ever called with a state that was actually dumped; a failed dump leaves the stored
 * one alone rather than replacing a working session with nothing.
 */
/** Create a profile from a running browser, so a closed one can be opened again. */
export async function createSessionProfile(opts: {
  name: string;
  state: unknown;
  providerId: number | null;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  originUrl: string | null;
  startUrl?: string | null;
  autostart?: boolean;
}): Promise<number | null> {
  try {
    const [row] = await db
      .insert(sessionProfilesTable)
      .values({
        name: opts.name,
        storageState: { enc: encrypt(JSON.stringify(opts.state)) },
        providerId: opts.providerId,
        fingerprintProfileId: opts.fingerprintProfileId,
        proxyProfileId: opts.proxyProfileId,
        originUrl: opts.originUrl,
        startUrl: opts.startUrl ?? null,
        autostart: opts.autostart ?? false,
      })
      .returning({ id: sessionProfilesTable.id });
    return row?.id ?? null;
  } catch (err) {
    logger.warn({ err, name: opts.name }, "Could not save the closed browser as a profile");
    return null;
  }
}

export async function saveSessionProfileState(
  id: number,
  state: unknown,
  originUrl?: string | null,
): Promise<boolean> {
  try {
    const patch: Record<string, unknown> = {
      storageState: { enc: encrypt(JSON.stringify(state)) },
      updatedAt: new Date(),
    };
    // Where it was when you closed it, so reopening resumes rather than restarts.
    if (originUrl) patch.originUrl = originUrl;
    await db.update(sessionProfilesTable).set(patch).where(eq(sessionProfilesTable.id, id));
    return true;
  } catch (err) {
    logger.warn({ err, id }, "Could not write the session back to its profile");
    return false;
  }
}

export async function loadSessionProfile(id: number): Promise<unknown | null> {
  try {
    const [row] = await db.select().from(sessionProfilesTable).where(eq(sessionProfilesTable.id, id));
    if (!row) return null;
    const raw = row.storageState as { enc?: string } | null;
    if (!raw?.enc) return null;
    return JSON.parse(decrypt(raw.enc));
  } catch (err) {
    logger.warn({ err, id }, "Could not load the session profile");
    return null;
  }
}
