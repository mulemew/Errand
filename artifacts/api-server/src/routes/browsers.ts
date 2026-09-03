import { Router, type IRouter } from "express";
import {
  db,
  providersTable,
  fingerprintProfilesTable,
  proxyProfilesTable,
  sessionProfilesTable,
  eq,
  desc,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { encrypt } from "../lib/encryption";
import {
  launchInstance,
  listInstances,
  getInstance,
  stopInstance,
  dumpInstanceSession,
} from "../lib/browserInstances";
import type { BrowserProviderConfig } from "../automation/browser-provider";
import { resolveProxyType } from "../automation/proxy-manager";
import { loadSessionProfile, saveSessionProfileState, createSessionProfile } from "../lib/browserSessionStore";

const router: IRouter = Router();

/**
 * Build the same browser config a TASK would get from the same three choices.
 *
 * This is the point of the whole feature: a session captured by hand is only reusable if
 * the run that reuses it looks identical, so the environment has to be assembled the same
 * way here as in the runner — provider type/url and its capability flags, the fingerprint
 * profile's fixed fingerprint, the proxy profile's URL.
 */
async function buildConfig(input: {
  providerId?: number | null;
  fingerprintProfileId?: number | null;
  proxyProfileId?: number | null;
}): Promise<BrowserProviderConfig> {
  // Assembled loosely and cast once at the end: BrowserProviderConfig is a wide union of
  // per-backend fields and writing it field-by-field through the typed shape would need a
  // cast at every assignment for no extra safety.
  // Every browser this file launches is one a person opens and leaves open.
  const config: Record<string, unknown> = { provider: "playwright", keepAlive: true };

  if (input.providerId) {
    const [p] = await db.select().from(providersTable).where(eq(providersTable.id, input.providerId));
    if (p) {
      config.provider = p.type;
      config.instanceUrl = p.url;
      if (p.stealth != null) config.stealth = p.stealth;
      if (p.blockAds != null) config.blockAds = p.blockAds;
      if (p.ignoreHttps != null) config.ignoreHTTPS = p.ignoreHttps;
      if (p.sessionTimeoutMs != null) config.sessionTimeoutMs = p.sessionTimeoutMs;
      if (p.humanize != null) config.humanize = p.humanize;
      if (p.blockWebrtc != null) config.blockWebrtc = p.blockWebrtc;
      if (p.viewportWidth && p.viewportHeight && !input.fingerprintProfileId) {
        config.viewportWidth = p.viewportWidth;
        config.viewportHeight = p.viewportHeight;
      }
    }
  }

  if (input.fingerprintProfileId) {
    const [f] = await db
      .select()
      .from(fingerprintProfilesTable)
      .where(eq(fingerprintProfilesTable.id, input.fingerprintProfileId));
    if (f) {
      const cfg = (f.config ?? {}) as Record<string, unknown>;
      config.fingerprint = { os: f.os, ...cfg };
    }
  }

  if (input.proxyProfileId) {
    const [pr] = await db.select().from(proxyProfilesTable).where(eq(proxyProfilesTable.id, input.proxyProfileId));
    if (pr?.url) {
      config.proxyUrl = pr.url;
      // Same single source of truth as the runner — see the note there.
      const t = resolveProxyType({ proxyUrl: pr.url });
      if (t) config.proxyType = t;
    }
  }
  return config as unknown as BrowserProviderConfig;
}

// ── Instances ────────────────────────────────────────────────────────────────

router.get("/browsers", async (_req, res): Promise<void> => {
  res.json(listInstances());
});

router.post("/browsers", async (req, res): Promise<void> => {
  const body = req.body as {
    name?: string;
    providerId?: number | null;
    fingerprintProfileId?: number | null;
    proxyProfileId?: number | null;
    /** Reopen a saved session: its cookies AND the environment they were made in. */
    sessionProfileId?: number | null;
    startUrl?: string;
    autostart?: boolean;
  };
  try {
    // Opening a profile is not "a new browser that happens to have cookies". A session is
    // only valid in the environment it was established in — same fingerprint, same exit IP
    // — so the profile's own provider/fingerprint/proxy are the defaults, and the request
    // may override them but does not have to supply them. Sending a saved session out
    // through a different exit IP is how a working login turns into a security prompt.
    let seed: unknown | null = null;
    let profile: {
      providerId: number | null;
      fingerprintProfileId: number | null;
      proxyProfileId: number | null;
      originUrl: string | null;
      openUrls: unknown;
      name: string;
    } | null = null;

    if (body.sessionProfileId != null) {
      const [row] = await db
        .select({
          name: sessionProfilesTable.name,
          providerId: sessionProfilesTable.providerId,
          fingerprintProfileId: sessionProfilesTable.fingerprintProfileId,
          proxyProfileId: sessionProfilesTable.proxyProfileId,
          originUrl: sessionProfilesTable.originUrl,
          openUrls: sessionProfilesTable.openUrls,
        })
        .from(sessionProfilesTable)
        .where(eq(sessionProfilesTable.id, body.sessionProfileId));
      if (!row) {
        res.status(404).json({ error: "No such session profile" });
        return;
      }
      profile = row;
      seed = await loadSessionProfile(body.sessionProfileId);
      if (!seed) {
        // The row exists but holds nothing usable. Opening anyway would look like the
        // session simply expired, which is a much harder thing to diagnose than this.
        res.status(422).json({
          error: `Session profile "${row.name}" has no stored session — it was saved empty, or with a backend that could not produce one.`,
        });
        return;
      }
    }

    const resolved = {
      ...body,
      providerId: body.providerId ?? profile?.providerId ?? null,
      fingerprintProfileId: body.fingerprintProfileId ?? profile?.fingerprintProfileId ?? null,
      proxyProfileId: body.proxyProfileId ?? profile?.proxyProfileId ?? null,
    };
    const config = await buildConfig(resolved);
    if (seed) (config as { storageState?: unknown }).storageState = seed;

    const name = (body.name ?? "").trim() || profile?.name || "browser";

    // A browser is a thing you keep, so it gets its row the moment it is created — not the
    // first time it is closed. Creating it on close meant a brand-new browser existed only
    // as a running process: nothing to rename, nothing to delete, and it vanished entirely
    // if the app restarted before you closed it. The row starts with an empty session and
    // fills in on close.
    let boundProfileId = body.sessionProfileId ?? null;
    if (boundProfileId == null) {
      boundProfileId = await createSessionProfile({
        name,
        state: { cookies: [], origins: [] },
        providerId: resolved.providerId,
        fingerprintProfileId: resolved.fingerprintProfileId,
        proxyProfileId: resolved.proxyProfileId,
        originUrl: (body.startUrl ?? "").trim() || null,
        // NOT start_url. On a new browser this is just "where to go first"; freezing it as
        // an override would mean the thing never resumes where it was left, which is the
        // behaviour that actually matters. The override is set by editing it later.
        autostart: body.autostart === true,
      });
    }

    const inst = await launchInstance({
      name,
      config,
      providerId: resolved.providerId,
      fingerprintProfileId: resolved.fingerprintProfileId,
      proxyProfileId: resolved.proxyProfileId,
      sessionProfileId: boundProfileId,
      // Land where the session was last used, so reopening shows the logged-in page rather
      // than a blank tab you have to navigate yourself.
      startUrl: (body.startUrl ?? "").trim() || profile?.originUrl || undefined,
      restoreTabs: Array.isArray(profile?.openUrls)
        ? (profile.openUrls as unknown[]).filter((u): u is string => typeof u === "string")
        : [],
    });
    res.status(201).json({ id: inst.id, sessionProfileId: boundProfileId });
  } catch (err) {
    logger.error({ err }, "Failed to launch a browser instance");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/browsers/:id/goto", async (req, res): Promise<void> => {
  const inst = getInstance(req.params.id ?? "");
  if (!inst) {
    res.status(404).json({ error: "No such browser instance" });
    return;
  }
  const url = String((req.body as { url?: string })?.url ?? "").trim();
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    await inst.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    inst.lastUsedAt = Date.now();
    res.json({ ok: true, url: inst.page.url() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete("/browsers/:id", async (req, res): Promise<void> => {
  const stopped = await stopInstance(req.params.id ?? "");
  res.json({ stopped });
});

// ── Saving a hand-made session as a profile ──────────────────────────────────

router.post("/browsers/:id/save-session", async (req, res): Promise<void> => {
  const inst = getInstance(req.params.id ?? "");
  if (!inst) {
    res.status(404).json({ error: "No such browser instance" });
    return;
  }
  const name = String((req.body as { name?: string })?.name ?? "").trim();
  // A browser opened FROM a profile updates that profile unless it is being deliberately
  // saved under a new name. Without this, "save" on a reopened browser quietly forks a
  // second copy every time, and the list fills with near-identical entries of which only
  // the newest is current.
  if (!name && inst.sessionProfileId != null) {
    const state = await dumpInstanceSession(inst);
    if (!state) {
      res.status(422).json({ error: "This backend did not return a session (no storageState and no cookie jar)." });
      return;
    }
    const ok = await saveSessionProfileState(inst.sessionProfileId, state);
    res.status(ok ? 200 : 500).json(
      ok ? { id: inst.sessionProfileId, updated: true } : { error: "Could not write the session back" },
    );
    return;
  }
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const state = await dumpInstanceSession(inst);
  if (!state) {
    res.status(422).json({
      error: "This backend did not return a session (no storageState and no cookie jar).",
    });
    return;
  }
  try {
    const [row] = await db
      .insert(sessionProfilesTable)
      .values({
        name,
        storageState: { enc: encrypt(JSON.stringify(state)) },
        providerId: inst.providerId,
        fingerprintProfileId: inst.fingerprintProfileId,
        proxyProfileId: inst.proxyProfileId,
        originUrl: (() => {
          try {
            return inst.page.url();
          } catch {
            return null;
          }
        })(),
      })
      .returning();
    logger.info({ id: row?.id, name }, "Saved a hand-made session as a profile");
    res.status(201).json({ id: row?.id, name });
  } catch (err) {
    logger.error({ err }, "Failed to save the session profile");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Session profiles ─────────────────────────────────────────────────────────

router.get("/session-profiles", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: sessionProfilesTable.id,
      name: sessionProfilesTable.name,
      providerId: sessionProfilesTable.providerId,
      fingerprintProfileId: sessionProfilesTable.fingerprintProfileId,
      proxyProfileId: sessionProfilesTable.proxyProfileId,
      originUrl: sessionProfilesTable.originUrl,
      autostart: sessionProfilesTable.autostart,
      updatedAt: sessionProfilesTable.updatedAt,
    })
    .from(sessionProfilesTable)
    .orderBy(desc(sessionProfilesTable.updatedAt));
  res.json(rows);
});

/**
 * Rename a saved browser, or move it to a different fingerprint/proxy.
 *
 * The stored session itself is never touched. Changing the environment does not migrate
 * the cookies into it — it changes where they will be REPLAYED next time, which is exactly
 * what you want after rotating a proxy and nothing more than that.
 */
router.patch("/session-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = req.body as {
    name?: string;
    fingerprintProfileId?: number | null;
    proxyProfileId?: number | null;
    /** Reopen this browser when the server starts. */
    autostart?: boolean;
    /** Where it opens next. Overwrites the stored last position; the next close
     *  overwrites it again with wherever you ended up. */
    startUrl?: string | null;
  };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      res.status(400).json({ error: "Name cannot be empty" });
      return;
    }
    patch.name = name;
  }
  // undefined means "not sent"; null means "clear it". They are different answers.
  if (body.fingerprintProfileId !== undefined) patch.fingerprintProfileId = body.fingerprintProfileId;
  if (body.proxyProfileId !== undefined) patch.proxyProfileId = body.proxyProfileId;
  if (typeof body.autostart === "boolean") patch.autostart = body.autostart;
  if (body.startUrl !== undefined) patch.originUrl = (body.startUrl ?? "").trim() || null;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [row] = await db
    .update(sessionProfilesTable)
    .set(patch)
    .where(eq(sessionProfilesTable.id, id))
    .returning({ id: sessionProfilesTable.id });
  if (!row) {
    res.status(404).json({ error: "No such session profile" });
    return;
  }
  res.json({ updated: true });
});

router.delete("/session-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Closing keeps a browser; deleting destroys it. So this also takes down whatever is
  // running from it — otherwise the row goes and the process stays, and the next close
  // would write back into an id that no longer exists.
  for (const inst of listInstances()) {
    if (inst.sessionProfileId === id) await stopInstance(inst.id).catch(() => {});
  }
  await db.delete(sessionProfilesTable).where(eq(sessionProfilesTable.id, id));
  res.json({ deleted: true });
});

/**
 * Reopen the browsers marked autostart, once, at boot.
 *
 * A hand-driven browser is a process, and a process does not survive a restart — the app
 * closes them on the way down (saving their cookies) and comes back with nothing running.
 * For most that is right: they are opened when you want to use them. For the few that are
 * meant to be permanently signed in somewhere, this puts them back.
 *
 * Deliberately sequential and best-effort: each one is a whole Firefox in the sidecar, and
 * a single unreachable proxy must not stop the rest or delay the server coming up.
 */
export async function restoreAutostartBrowsers(): Promise<void> {
  let rows: Array<{ id: number; name: string }> = [];
  try {
    rows = await db
      .select({ id: sessionProfilesTable.id, name: sessionProfilesTable.name })
      .from(sessionProfilesTable)
      .where(eq(sessionProfilesTable.autostart, true));
  } catch (err) {
    logger.warn({ err }, "Could not read the autostart browsers");
    return;
  }
  if (rows.length === 0) return;
  logger.info({ count: rows.length }, "Reopening browsers marked autostart");
  for (const row of rows) {
    try {
      const [full] = await db
        .select({
          providerId: sessionProfilesTable.providerId,
          fingerprintProfileId: sessionProfilesTable.fingerprintProfileId,
          proxyProfileId: sessionProfilesTable.proxyProfileId,
          originUrl: sessionProfilesTable.originUrl,
          openUrls: sessionProfilesTable.openUrls,
        })
        .from(sessionProfilesTable)
        .where(eq(sessionProfilesTable.id, row.id));
      if (!full) continue;
      const config = await buildConfig(full);
      const seed = await loadSessionProfile(row.id);
      if (seed) (config as { storageState?: unknown }).storageState = seed;
      await launchInstance({
        name: row.name,
        config,
        providerId: full.providerId,
        fingerprintProfileId: full.fingerprintProfileId,
        proxyProfileId: full.proxyProfileId,
        sessionProfileId: row.id,
        startUrl: full.originUrl || undefined,
        restoreTabs: Array.isArray(full.openUrls)
          ? (full.openUrls as unknown[]).filter((u): u is string => typeof u === "string")
          : [],
      });
      logger.info({ sessionProfileId: row.id, name: row.name }, "Autostart browser reopened");
    } catch (err) {
      logger.warn({ err, sessionProfileId: row.id, name: row.name }, "Autostart browser did not reopen");
    }
  }
}

export default router;
