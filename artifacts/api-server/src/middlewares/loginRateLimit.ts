import { Request, Response, NextFunction } from "express";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// #1 — Map is cleaned up periodically so it never grows unboundedly
const attempts = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(ip);
  }
}, WINDOW_MS).unref();

/**
 * Who to count this attempt against.
 *
 * NOT X-Forwarded-For, unless the deployment has said that header can be believed.
 *
 * The header is attacker-controlled: anyone can send any value, so a limiter keyed on it
 * has no limit at all — a fresh value per request is a fresh bucket, and this guards the
 * single password to an admin panel that hands back other systems' credentials in plain
 * text. The previous version filtered for "things that look like an IP", which does not
 * help, because an attacker picks valid-looking addresses. (It also let `abc` through:
 * a, b and c are hex digits.)
 *
 * So the socket address is the default, and the header is honoured only when
 * TRUST_PROXY_HOPS says how many proxies sit in front — what Express's `trust proxy`
 * means, kept local so it governs this decision rather than everything. Behind one
 * reverse proxy set it to 1: the entry counted from the right is then the address that
 * proxy observed, which a client cannot forge by prepending entries of its own.
 */
const TRUST_PROXY_HOPS = Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? 0) || 0);

function getClientIp(req: Request): string {
  const direct = req.socket.remoteAddress ?? "unknown";
  if (TRUST_PROXY_HOPS <= 0) return direct;

  const raw = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(raw) ? raw.join(",") : raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  // Counted from the RIGHT: each hop appends, so the rightmost entries are the ones our
  // own infrastructure wrote. Taking the leftmost is precisely what makes spoofing work.
  const idx = chain.length - TRUST_PROXY_HOPS;
  const candidate = idx >= 0 ? chain[idx] : chain[0];
  return candidate || direct;
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  entry.count += 1;

  if (entry.count > MAX_ATTEMPTS) {
    const retryAfterSecs = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", retryAfterSecs);
    res.status(429).json({ error: "Too many login attempts. Please try again later." });
    return;
  }

  next();
}
