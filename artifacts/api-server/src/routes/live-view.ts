import { Router, type IRouter } from "express";
import type { Server } from "http";
import net from "net";
import { logger } from "../lib/logger";
import { db, providersTable, tasksTable, eq } from "@workspace/db";
import { getTaskView } from "../lib/taskViews";

/**
 * Live view of a provider's browser, served THROUGH this app.
 *
 * The sidecar renders a real headful browser on its Xvfb and x11vnc/noVNC publishes that
 * display — but publishing it as its own port is useless behind a reverse proxy: a typical
 * deployment is CDN → nginx → this app on one origin, and a second port is neither routed
 * nor authenticated. So the app proxies it instead: same origin, same session cookie, same
 * TLS, nothing extra to expose. The sidecar's VNC port never leaves the docker network.
 *
 * Two halves, because noVNC is two protocols:
 *   • the client itself (HTML/JS/CSS) over plain HTTP — handled by the router below
 *   • the framebuffer over a WebSocket — handled by attachLiveViewUpgrade(), since Express
 *     never sees an HTTP upgrade
 */

const VNC_PORT = Number(process.env.CAMOUFOX_VNC_PORT ?? 7900);

/**
 * Where to point the proxy.
 *
 * The id is either a provider ("7" — the container's shared display, which shows every
 * concurrent run at once) or a task ("task-37" — that run's OWN display, which is what you
 * almost always want). A task with no session running falls back to its provider's shared
 * display, so the button works whether or not the task is mid-run.
 */
async function liveViewTarget(id: string): Promise<{ host: string; port: number } | null> {
  const taskMatch = id.match(/^task-(\d+)$/);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    const own = getTaskView(taskId);
    if (own) return own;
    // Not running (or the sidecar could not give it a display): fall back to whichever
    // provider this task uses.
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    const bc = task?.browserConfig as { providerId?: number | null } | null;
    if (bc?.providerId) return providerTarget(bc.providerId);
    const [def] = await db.select().from(providersTable).where(eq(providersTable.isDefault, true));
    return def ? providerTarget(def.id) : null;
  }
  const providerId = parseInt(id, 10);
  return isNaN(providerId) ? null : providerTarget(providerId);
}

/** The container-wide display of one provider's sidecar. */
async function providerTarget(providerId: number): Promise<{ host: string; port: number } | null> {
  const [p] = await db.select().from(providersTable).where(eq(providersTable.id, providerId));
  if (!p?.url) return null;
  // Only the camoufox sidecar runs the viewer today.
  if (p.type !== "camoufox") return null;
  try {
    const u = new URL(p.url);
    return { host: u.hostname, port: VNC_PORT };
  } catch {
    return null;
  }
}

const router: IRouter = Router();

/**
 * Proxy the noVNC client. Everything under this prefix is forwarded verbatim, because the
 * client asks for its own assets by relative path once loaded.
 */
router.use("/live-view/:id", async (req, res): Promise<void> => {
  const viewId = req.params.id ?? "";
  const target = await liveViewTarget(viewId);
  if (!target) {
    res.status(404).json({ error: "This provider has no live view (camoufox only)" });
    return;
  }

  // The bare directory REDIRECTS to vnc.html with its settings in the query string.
  //
  // These used to be appended to the URL the app fetched from the sidecar, which does
  // nothing at all: noVNC reads its configuration from window.location.search — the
  // BROWSER's address — and that was just "/api/live-view/1/" with no query. So it fell
  // back to its defaults and dialled wss://<this-host>/websockify, a path that belongs to
  // the SPA, not to this route. The socket never reached the app: no upgrade, no error,
  // just "Connecting…" forever, which is exactly what the access log showed — every asset
  // 200 and not one request for websockify.
  //
  // Redirecting puts the settings where the client actually looks.
  if (req.url === "/" || req.url === "") {
    const qs =
      `autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000` +
      `&path=${encodeURIComponent(`api/live-view/${viewId}/websockify`)}`;
    res.redirect(302, `vnc.html?${qs}`); // relative: resolves under this same prefix
    return;
  }
  const path = req.url;

  try {
    const upstream = await fetch(`http://${target.host}:${target.port}${path}`, {
      headers: { accept: req.headers.accept ?? "*/*" },
      signal: AbortSignal.timeout(15_000),
    });
    res.status(upstream.status);
    const type = upstream.headers.get("content-type");
    if (type) res.setHeader("Content-Type", type);
    // The viewer must never be cached: it is a live socket bootstrap, not a document.
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    // Say WHERE it failed. A 502 from this route and a 502 from the reverse proxy in front
    // of the app look identical in a browser, and the difference decides where to look.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { viewId, target: `${target.host}:${target.port}`, path, reason },
      "Live view upstream did not answer",
    );
    res.status(502).json({
      error: `The live view at ${target.host}:${target.port} did not answer (${reason}).`,
      hint:
        "This is the app talking to the sidecar, not your reverse proxy. Check that the camoufox container is running a recent image: `docker logs <camoufox> | grep vnc` should show '[vnc] live view ready'.",
      target: `${target.host}:${target.port}`,
    });
  }
});

/**
 * The WebSocket half.
 *
 * Express hands back plain sockets on upgrade, so this pipes bytes: connect to the
 * sidecar's websockify, replay the client's handshake, then let both directions stream.
 * No framing, no parsing — a VNC session is opaque to us and should stay that way.
 *
 * Auth: the upgrade carries the same session cookie as any other request, and this app is
 * behind requireAuth, so an unauthenticated upgrade is rejected before it reaches a socket.
 */
export function attachLiveViewUpgrade(server: Server, isAuthorised: (cookie: string) => Promise<boolean>): void {
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const m = url.match(/^\/api\/live-view\/([^/]+)\/websockify/);
    if (!m) return; // not ours — leave it for anything else listening

    void (async () => {
      // Every step is logged. "Connecting…" forever has three possible causes — the upgrade
      // never reached this process (a reverse proxy that does not forward Upgrade), it was
      // refused here, or the sidecar did not answer — and they are indistinguishable from
      // the browser. If none of these lines appear at all, the request never arrived.
      logger.info({ url, hasCookie: !!req.headers.cookie }, "Live view upgrade received");
      try {
        if (!(await isAuthorised(req.headers.cookie ?? ""))) {
          logger.warn({ url }, "Live view upgrade REFUSED — no valid session cookie on the upgrade request");
          socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
          return;
        }
        const target = await liveViewTarget(decodeURIComponent(m[1] ?? ""));
        if (!target) {
          logger.warn({ url }, "Live view upgrade has no target (not a camoufox provider?)");
          socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
          return;
        }

        const upstream = net.connect(target.port, target.host, () => {
          // Replay the handshake unchanged apart from the path, which the sidecar serves
          // at its own root.
          const headers = Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
            .join("\r\n");
          upstream.write(`GET /websockify HTTP/1.1\r\n${headers}\r\n\r\n`);
          if (head?.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
          logger.info({ target: `${target.host}:${target.port}` }, "Live view upgrade piped to the sidecar");
        });

        const close = () => {
          try { upstream.destroy(); } catch { /* ignore */ }
          try { socket.destroy(); } catch { /* ignore */ }
        };
        upstream.on("error", (err) => {
          logger.warn({ target: `${target.host}:${target.port}`, err: String(err) }, "Live view upstream socket failed");
          close();
        });
        socket.on("error", close);
        socket.on("close", close);
      } catch (err) {
        logger.warn({ err }, "Live view upgrade failed");
        try { socket.destroy(); } catch { /* ignore */ }
      }
    })();
  });
}

export default router;
