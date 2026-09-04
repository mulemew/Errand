// Must run before any other import that reads env vars
  import { ensureSecrets } from "./lib/auto-secrets";
  ensureSecrets();

  import app from "./app";
  import { logger, setConfiguredLevel } from "./lib/logger";
  import { initScheduler } from "./scheduler";
  import { backfillExitGeo } from "./routes/tasks";
  import { restoreAutostartBrowsers } from "./routes/browsers";
  import { startProviderHealthPolling, seedProvidersFromSettings, autoBindTasksToProviders, ensureDefaultProvider, releaseOrphanCamoufoxSessions } from "./automation/providers";
  import { installSignalHandlers } from "./lib/child-registry";
  import { runMigrations } from "./lib/migrations";
  import { hasStoredPassword, initPassword } from "./lib/passwordStore";
  import { loadLogConfig } from "./lib/appSettings";
  import { attachLiveViewUpgrade } from "./routes/live-view";
  import { hasSession } from "./lib/sessions";
  import { stopAllInstances } from "./lib/browserInstances";
  import cookieParser from "cookie-parser";
  import { pool } from "@workspace/db";

  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error("PORT environment variable is required but was not provided.");
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const keyBuf = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  if (keyBuf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Got ${keyBuf.length} bytes.`
    );
  }

  await runMigrations();

  // Ensure columns added in newer versions exist on older DB deployments.
  // ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent and safe on every startup.
  try {
    await pool.query(`
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS triggered_by text;
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS step_logs jsonb;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    `);
    logger.info("Schema column migrations applied");
  } catch (err) {
    logger.warn({ err }, "Schema column migration warning (non-fatal)");
  }

  // The logger boots at LOG_LEVEL (or info) because it exists long before the database
  // does; now that migrations have run, adopt whatever the Settings page saved.
  try {
    const { level } = await loadLogConfig();
    if (level !== logger.level) {
      logger.info({ from: logger.level, to: level }, "Applying saved log level");
      setConfiguredLevel(level);
    }
  } catch (err) {
    logger.warn({ err }, "Could not load the saved log level — keeping the environment's");
  }

  const envPassword = process.env.DASHBOARD_PASSWORD;
  if (envPassword && !(await hasStoredPassword())) {
    const result = await initPassword(envPassword);
    if (result.ok) {
      logger.info("DASHBOARD_PASSWORD env var detected — password initialised in database automatically");
    } else {
      logger.warn({ error: result.error }, "DASHBOARD_PASSWORD env var present but initPassword failed");
    }
  }

  const server = app.listen(port, async (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    // The live-view WebSocket: Express never sees an HTTP upgrade, so it is wired to the
    // server directly. Same session cookie as every other request — an unauthenticated
    // upgrade is closed before any socket to the sidecar is opened.
    attachLiveViewUpgrade(server, async (cookieHeader) => {
      try {
        // One cookie out of a header — not worth a parser dependency, and this runs on a
        // socket upgrade where cookie-parser's middleware form is not available.
        const raw = (cookieHeader ?? "")
          .split(";")
          .map((c) => c.trim())
          .find((c) => c.startsWith("session="))
          ?.slice("session=".length);
        if (!raw) return false;
        const token = cookieParser.signedCookie(decodeURIComponent(raw), process.env.SESSION_SECRET ?? "");
        return typeof token === "string" && (await hasSession(token));
      } catch {
        return false;
      }
    });
    // Reap sing-box/Xvfb helpers on SIGTERM/SIGINT/fatal errors — nothing killed
    // them before, so every restart left orphans behind.
    installSignalHandlers(async () => {
      // Stop accepting first, and let requests already in flight answer. Without this the
      // process exited with sockets mid-response, so a deploy could cut a save in half —
      // the client sees a network error and cannot tell whether the write landed.
      //
      // Bounded, because this app holds connections open on purpose: the live-view socket
      // and the task-event stream never end by themselves, and waiting for them would turn
      // every restart into a hang that ends in SIGKILL anyway.
      await new Promise<void>((resolve) => {
        const done = setTimeout(() => {
          logger.warn("Some connections did not close in time — continuing shutdown");
          resolve();
        }, 10_000);
        server.close(() => {
          clearTimeout(done);
          resolve();
        });
        // Long-lived streams would otherwise hold the close open for the full timeout.
        server.closeIdleConnections?.();
      });
      // Hand-driven browsers are held open deliberately; on the way out they must still be
      // released, or the sidecar keeps a Firefox per instance until its own TTL.
      await stopAllInstances().catch(() => {});
      await pool.end().catch(() => {});
    });
    await initScheduler();
    // Fill exit-geo for pre-existing tasks in the background (non-blocking).
    void backfillExitGeo();
    // One-time: seed a provider from the current Settings backend so the page isn't empty
    // after the config moved out of Settings; then keep provider health fresh.
    await seedProvidersFromSettings();
    // One-time: bind existing tasks to the matching-type provider so you don't have to
    // open each task and pick one. Runs after the seed so seeded providers count too.
    await autoBindTasksToProviders();
    // The browser backend is configured only on the Providers page now, so tasks that
    // picked "默认" need a provider flagged as such. Promote one if nothing is flagged.
    await ensureDefaultProvider();
    // Tasks running at shutdown were reset to idle — kill the browser sessions they left
    // behind in the camoufox sidecars instead of letting them idle until the TTL reaper.
    //
    // AWAITED, and the autostart restore comes after it, because /release-all kills every
    // live session in the sidecar. Fired in parallel, it would have shot the browsers the
    // restore had just launched — a race whose outcome depended on which HTTP call landed
    // first, and the restore is the slow one (a Firefox per browser).
    await releaseOrphanCamoufoxSessions();
    // Browsers marked autostart. Not awaited: each is a real Firefox in the sidecar and
    // none of that should hold up the rest of the boot.
    void restoreAutostartBrowsers();
    startProviderHealthPolling();
  });
  