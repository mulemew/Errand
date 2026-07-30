import { Router, type IRouter } from "express";
import type { Server } from "http";
import net from "net";
import { logger } from "../lib/logger";
import { db, providersTable, eq } from "@workspace/db";

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

/** host:port of a provider's live view, or null when the provider cannot offer one. */
async function liveViewTarget(providerId: number): Promise<{ host: string; port: number } | null> {
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
  const providerId = parseInt(req.params.id ?? "", 10);
  if (isNaN(providerId)) {
    res.status(400).json({ error: "Invalid provider id" });
    return;
  }
  const target = await liveViewTarget(providerId);
  if (!target) {
    res.status(404).json({ error: "This provider has no live view (camoufox only)" });
    return;
  }

  // "" → the noVNC page itself. autoconnect + the path the WebSocket half is mounted on,
  // so the client connects back through this app rather than to the sidecar directly.
  let path = req.url === "/" || req.url === "" ? "/vnc.html" : req.url;
  if (path === "/vnc.html") {
    path += `?autoconnect=1&resize=scale&path=${encodeURIComponent(`api/live-view/${providerId}/websockify`)}`;
  }

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
    logger.warn({ err, providerId }, "Live view is not reachable — is VNC_ENABLE=1 on the sidecar?");
    res.status(502).json({
      error:
        "The provider's live view is not answering. Set VNC_ENABLE=1 and VNC_PASSWORD on the camoufox sidecar and restart it.",
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
    const m = url.match(/^\/api\/live-view\/(\d+)\/websockify/);
    if (!m) return; // not ours — leave it for anything else listening

    void (async () => {
      try {
        if (!(await isAuthorised(req.headers.cookie ?? ""))) {
          socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
          return;
        }
        const target = await liveViewTarget(Number(m[1]));
        if (!target) {
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
        });

        const close = () => {
          try { upstream.destroy(); } catch { /* ignore */ }
          try { socket.destroy(); } catch { /* ignore */ }
        };
        upstream.on("error", close);
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
