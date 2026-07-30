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
  const config: Record<string, unknown> = { provider: "playwright" };

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
      const scheme = (pr.url.split("://")[0] || "").toLowerCase();
      const t = scheme === "socks5h" ? "socks5" : scheme;
      if (["http", "socks5", "vless", "vmess", "trojan", "hy2", "tuic", "ss"].includes(t)) {
        config.proxyType = t;
      }
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
    startUrl?: string;
  };
  try {
    const config = await buildConfig(body);
    const inst = await launchInstance({
      name: (body.name ?? "").trim() || "browser",
      config,
      providerId: body.providerId ?? null,
      fingerprintProfileId: body.fingerprintProfileId ?? null,
      proxyProfileId: body.proxyProfileId ?? null,
      startUrl: (body.startUrl ?? "").trim() || undefined,
    });
    res.status(201).json({ id: inst.id });
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
      updatedAt: sessionProfilesTable.updatedAt,
    })
    .from(sessionProfilesTable)
    .orderBy(desc(sessionProfilesTable.updatedAt));
  res.json(rows);
});

router.delete("/session-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(sessionProfilesTable).where(eq(sessionProfilesTable.id, id));
  res.json({ deleted: true });
});

export default router;
