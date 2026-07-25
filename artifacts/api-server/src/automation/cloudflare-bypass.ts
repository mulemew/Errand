import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { execSync, execFileSync } from "child_process";

type CfChallengeType = "js_challenge" | "turnstile_click" | "waf_blocked" | "none";

// ── xdotool availability (checked once at startup) ──────────────────────────

let _xdotoolAvailable: boolean | null = null;
function isXdotoolAvailable(): boolean {
  if (_xdotoolAvailable === null) {
    // Require BOTH the xdotool binary AND a DISPLAY. The app container ships
    // xdotool but has NO X server when running the cf-proxy backend (the browser
    // and Xvfb live in the cf-proxy container), so every xdotool call fails with
    // "Can't open display: (null) / Failed creating new xdo instance". Only the
    // local/patchright backend runs Chrome on the app container's own Xvfb
    // (DISPLAY=:99). Gate on DISPLAY so we never spam those errors or waste time.
    if (!process.env.DISPLAY) {
      _xdotoolAvailable = false;
      logger.debug("No DISPLAY in this container — OS-level xdotool clicking disabled (expected on the cf-proxy backend)");
      return _xdotoolAvailable;
    }
    try {
      execSync("which xdotool", { stdio: "ignore" });
      _xdotoolAvailable = true;
      logger.info("xdotool detected — OS-level clicking enabled for Turnstile");
    } catch {
      _xdotoolAvailable = false;
      logger.debug("xdotool not found — falling back to CDP mouse events");
    }
  }
  return _xdotoolAvailable;
}

// ── Process-level GUI lock ───────────────────────────────────────────────────
// The "local"/patchright browser provider runs every concurrent task's Chromium
// on ONE shared Xvfb virtual display (:99), which means they all share a single
// mouse cursor and keyboard focus. xdotool moves that shared pointer and raises
// a window, so if two tasks physically click a Turnstile at the same time they
// fight over the cursor/focus and both clicks land in the wrong window. This is
// the TS-side counterpart to cf-proxy's `_gui_lock`: serialize every OS-level
// xdotool interaction so each task gets an uninterrupted turn at the display.
let _guiLockChain: Promise<void> = Promise.resolve();
function withGuiLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = _guiLockChain.then(() => fn());
  // Keep the chain alive regardless of whether `fn` resolves or rejects.
  _guiLockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Turnstile iframe expansion script ───────────────────────────────────────
// Ported from the JustRunMy.App reference project.
// Forcefully expands hidden/overflow:hidden containers around the Turnstile
// widget so that the checkbox is visible and clickable.

// IMPORTANT: this MUTATES the widget, and Turnstile restarts its verification when its
// container is resized or moved. It used to run unconditionally — at bypass entry, in
// every wait loop iteration, before every click — which kept the box spinning forever
// because we reset its timer faster than it could finish. It now only touches a widget
// that is actually unusable (clipped or zero-sized), and `expandTurnstileIfClipped()`
// runs it at most once per page.
const EXPAND_TURNSTILE_JS = `
(function() {
  var ts = document.querySelector('input[name="cf-turnstile-response"], input[id^="cf-chl-widget-"][id$="_response"]');
  var containers = document.querySelectorAll('.cf-turnstile, [data-sitekey], [id^="cf-chl-widget"]');
  if (!ts && containers.length === 0) return 'no-turnstile';

  // Is the widget already usable? Then touch NOTHING — every style change we make can
  // restart the challenge.
  var probe = (ts && ts.parentElement) || containers[0];
  var frames = Array.prototype.filter.call(document.querySelectorAll('iframe'), function (f) {
    return f.src && (f.src.indexOf('challenges.cloudflare.com') >= 0 || f.src.indexOf('turnstile') >= 0);
  });
  var target = frames[0] || probe;
  if (target) {
    var tr = target.getBoundingClientRect();
    var ts_ = window.getComputedStyle(target);
    var usable = tr.width >= 40 && tr.height >= 20 &&
      ts_.visibility !== 'hidden' && ts_.display !== 'none' && parseFloat(ts_.opacity || '1') > 0.1;
    if (usable) return 'already-visible';
  }

  // Only now: un-clip the ancestors. Relaxing overflow does not move or resize the
  // widget itself, so it is the safe half of the old script.
  var el = probe;
  for (var i = 0; i < 20 && el; i++) {
    el = el.parentElement;
    if (!el) break;
    var s = window.getComputedStyle(el);
    if (s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden')
      el.style.overflow = 'visible';
    // NOTE: do NOT set minWidth:'max-content' on ancestors. It forces
    // long-text containers (e.g. the "Renew your Free plan" modal) to stop
    // wrapping and stretch to the full viewport width, distorting the dialog.
  }
  // Last resort — resize the iframe itself, ONLY when it is still unusable. This is the
  // change Turnstile is most likely to react to, so it is gated behind everything above.
  frames.forEach(function (f) {
    var r = f.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 20) return;
    f.style.width = '300px'; f.style.height = '65px'; f.style.minWidth = '300px';
    f.style.visibility = 'visible'; f.style.opacity = '1';
  });
  return 'expanded';
})()
`;

/** Run the expansion AT MOST ONCE per page, and only if the widget needs it. */
const _expanded = new WeakSet<object>();
async function expandTurnstileIfClipped(page: PageAdapter): Promise<void> {
  if (_expanded.has(page as object)) return;
  _expanded.add(page as object);
  try {
    const r = await page.evaluate(EXPAND_TURNSTILE_JS as unknown as string);
    if (r === "expanded") logger.info("Turnstile widget was clipped — un-clipped it once");
  } catch { /* non-critical */ }
}

// ── Backend flavour ───────────────────────────────────────────────────────────

/** Camoufox is a patched FIREFOX. Chromium-only tricks (window.chrome, the Network
 *  Information API, xdotool against a "chrome" window class) are wrong there — injecting
 *  them during a challenge is exactly the inconsistency CF is looking for. */
const _isFirefox = new WeakMap<object, boolean>();
async function isFirefoxPage(page: PageAdapter): Promise<boolean> {
  const cached = _isFirefox.get(page as object);
  if (cached !== undefined) return cached;
  let v = false;
  try {
    v = (await page.evaluate(() => /Firefox\//.test(navigator.userAgent))) as boolean;
  } catch { /* keep false */ }
  _isFirefox.set(page as object, v);
  return v;
}

/**
 * Click like a hand does: land on the point, dwell, press, hold, release.
 *
 * `mouse.click()` fires mousedown and mouseup in the SAME millisecond — a press duration
 * no human produces, and one of the cheapest bot signals Turnstile can read. Falls back
 * to click() on adapters without down/up (cf-proxy drives the real OS mouse itself).
 */
async function humanClickAt(page: PageAdapter, x: number, y: number): Promise<void> {
  // Approach from slightly off-target so the widget sees pointer movement arriving,
  // not a cursor teleporting onto the checkbox. On camoufox `humanize` turns each of
  // these into a real interpolated trajectory inside the browser.
  await page.mouse.move(x - rand(18, 45), y + rand(-14, 14)).catch(() => {});
  await sleep(rand(90, 220));
  await page.mouse.move(x, y).catch(() => {});
  await sleep(rand(120, 350)); // dwell before pressing
  if (page.mouse.down && page.mouse.up) {
    await page.mouse.down();
    await sleep(rand(60, 140)); // press duration
    await page.mouse.up();
  } else {
    await page.mouse.click(x, y);
  }
}

/**
 * What the widget itself says right now — the single most useful line when a click did
 * not work, and something a screenshot only hints at. The Turnstile iframe is reachable
 * through frames() even though it lives in a closed shadow root, and its body text is the
 * verdict in plain words: "Verify you are human" (never clicked), "Verifying…" (still
 * spinning — we were too impatient or reset it), "Success!", or "Verification failed".
 */
export async function describeTurnstileState(page: PageAdapter): Promise<string> {
  try {
    const frame = page
      .frames()
      .find((f: { url(): string }) => CF_FRAME_PATTERNS.some((p) => f.url().includes(p)));
    if (!frame) return "no turnstile frame";
    const body = await frame.$("body").catch(() => null);
    if (!body) return "frame present, no body";
    const text = (await body
      .evaluate((e: Element) => ((e as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 120))
      .catch(() => "")) as string;
    return text || "(empty)";
  } catch {
    return "(unreadable)";
  }
}

/** Turnstile checks document.hasFocus(); on the camoufox sidecar every concurrent
 *  session shares one Xvfb, so only one window is focused. Raise ours and report. */
async function ensureFocused(page: PageAdapter, where: string): Promise<void> {
  try { await page.bringToFront?.(); } catch { /* not supported */ }
  try {
    const focused = (await page.evaluate(() => document.hasFocus())) as boolean;
    if (!focused) logger.warn({ where }, "Page does NOT have focus — Turnstile may refuse to complete");
  } catch { /* ignore */ }
}

// ── xdotool-based physical click ────────────────────────────────────────────
// Uses OS-level X11 events that are indistinguishable from real human input.
// CF's Turnstile cannot detect these as automation because they come from the
// window system, not from CDP's Input.dispatchMouseEvent.

function xdotoolActivateChrome(): string | null {
  const classNames = ["chrome", "chromium", "Chromium", "Chrome", "google-chrome"];
  for (const cls of classNames) {
    try {
      const result = execFileSync("xdotool", ["search", "--onlyvisible", "--class", cls], {
        timeout: 3000, encoding: "utf-8",
      }).trim();
      const wids = result.split("\n").filter(Boolean);
      if (wids.length > 0) {
        execFileSync("xdotool", ["windowactivate", "--sync", wids[0]], {
          timeout: 3000, stdio: "ignore",
        });
        return wids[0];
      }
    } catch { /* try next class name */ }
  }
  try {
    execFileSync("xdotool", ["getactivewindow", "windowactivate"], {
      timeout: 3000, stdio: "ignore",
    });
  } catch { /* ignore */ }
  return null;
}

/**
 * Get the actual window position via xdotool getwindowgeometry.
 * This is reliable in Xvfb unlike window.screenX/screenY which return 0.
 */
function xdotoolGetWindowGeometry(wid: string): { x: number; y: number } | null {
  try {
    const out = execFileSync("xdotool", ["getwindowgeometry", "--shell", wid], {
      timeout: 3000, encoding: "utf-8",
    });
    let x = 0, y = 0;
    for (const line of out.trim().split("\n")) {
      if (line.startsWith("X=")) x = parseInt(line.split("=")[1], 10);
      else if (line.startsWith("Y=")) y = parseInt(line.split("=")[1], 10);
    }
    return { x, y };
  } catch {
    return null;
  }
}

function xdotoolClick(x: number, y: number): void {
  xdotoolActivateChrome();
  try {
    execFileSync("xdotool", ["mousemove", "--sync", String(Math.round(x)), String(Math.round(y))], {
      timeout: 3000, stdio: "ignore",
    });
    execFileSync("xdotool", ["click", "1"], { timeout: 2000, stdio: "ignore" });
    logger.info({ x: Math.round(x), y: Math.round(y) }, "xdotool physical click dispatched");
  } catch (err) {
    logger.debug({ err }, "xdotool click failed, falling back");
  }
}

/**
 * Attempt a physical OS-level click on the Turnstile checkbox.
 * Falls back to CDP click if xdotool is unavailable.
 */
async function physicalClickTurnstile(page: PageAdapter): Promise<boolean> {
  // Get Turnstile iframe coordinates via JS injection
  const coords = await page.evaluate(() => {
    // The Cloudflare Turnstile checkbox is a FIXED-size control (~24px) sitting
    // after ~13px of left padding, so its centre is ~30px from the widget's left
    // edge REGARDLESS of the widget's total width. A proportional offset
    // (width * 0.06 → 14-18px) lands in the padding to the LEFT of the checkbox
    // and misses it, which reads as "verification failed" / an unchecked box.
    // Use a fixed ~30px offset (clamped for unusually narrow widgets).
    const checkboxOffsetX = (r: DOMRect) => Math.round(Math.min(r.width - 8, 30));
    // First try iframes
    const iframes = document.querySelectorAll("iframe");
    for (let i = 0; i < iframes.length; i++) {
      const src = iframes[i].src || "";
      if (src.includes("cloudflare") || src.includes("turnstile") || src.includes("challenges")) {
        const r = iframes[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0)
          return { cx: Math.round(r.x + checkboxOffsetX(r)), cy: Math.round(r.y + r.height / 2) };
      }
    }
    // Fallback: container element
    const containers = Array.from(document.querySelectorAll<HTMLElement>(".cf-turnstile, [data-sitekey]"));
    for (const container of containers) {
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        return { cx: Math.round(r.x + checkboxOffsetX(r)), cy: Math.round(r.y + r.height / 2) };
    }
    return null;
  }) as { cx: number; cy: number } | null;

  if (!coords) {
    logger.debug("Could not locate Turnstile coordinates for physical click");
    return false;
  }

  if (isXdotoolAvailable()) {
    // Serialize the whole activate→geometry→click sequence on the shared
    // Xvfb :99 pointer/focus so concurrent tasks don't fight over the cursor.
    return withGuiLock(async () => {
      // Get browser window position to compute absolute screen coordinates
      // Prefer xdotool getwindowgeometry (accurate in Xvfb) over window.screenX/Y
      const wid = xdotoolActivateChrome();
      let winX = 0, winY = 0;
      if (wid) {
        const geo = xdotoolGetWindowGeometry(wid);
        if (geo) {
          winX = geo.x;
          winY = geo.y;
        }
      }

      const winInfo = await page.evaluate(() => ({
        sx: (window as any).screenX || 0,
        sy: (window as any).screenY || 0,
        oh: window.outerHeight,
        ih: window.innerHeight,
      })) as { sx: number; sy: number; oh: number; ih: number };

      // Use xdotool geometry if available, fall back to JS values
      if (winX === 0 && winY === 0) {
        winX = winInfo.sx;
        winY = winInfo.sy;
      }
      const titleBarHeight = Math.max(0, winInfo.oh - winInfo.ih);
      const absX = coords.cx + winX;
      const absY = coords.cy + winY + titleBarHeight;

      logger.info({ absX, absY, coords, winX, winY, titleBarHeight }, "Attempting xdotool physical click on Turnstile");
      xdotoolClick(absX, absY);
      await sleep(600);
      return await isTurnstileSolved(page);
    });
  }

  // Fallback: CDP click (less effective but better than nothing)
  logger.debug({ coords }, "Falling back to CDP mouse click on Turnstile");
  await page.mouse.move(coords.cx, coords.cy);
  await sleep(150 + Math.random() * 200);
  await page.mouse.click(coords.cx, coords.cy);
  await sleep(600);
  return await isTurnstileSolved(page);
}

/** Partial URL strings that identify CF Turnstile iframes */
const CF_FRAME_PATTERNS = ["challenges.cloudflare.com", "cf-turnstile"];

// ── Detection ─────────────────────────────────────────────────────────────────

type CfPageProbe = {
  blocked: boolean;
  marker: boolean;
  legacy: boolean;
  title: string;
  visibleWidget: boolean;
  turnstileIframe: boolean;
};

async function detectCfChallenge(page: PageAdapter): Promise<CfChallengeType> {
  // Pre-fetch frames for SeleniumBase adapter (frames() is sync but needs async HTTP)
  if ("fetchFrames" in page && typeof (page as any).fetchFrames === "function") {
    await (page as any).fetchFrames();
  }

  // ONE evaluate for the whole page-side verdict.
  //
  // This used to be four to six separate evaluates (WAF text, structural markers, title,
  // a $()+evaluate per legacy selector, the visible-widget probe, an iframe scan) and it
  // is called on a poll while a challenge is watching the page — a burst of injected
  // scripts every couple of seconds is itself something CF scores. Same logic, one call.
  let probe: CfPageProbe | null = null;
  try {
    probe = (await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const title = document.title ?? "";

      // ── WAF block — "Sorry, you have been blocked". Not a challenge: no browser
      // technique clears it, the IP/fingerprint is refused at the edge.
      const blocked =
        bodyText.includes("you have been blocked") ||
        bodyText.includes("You are unable to access") ||
        title.includes("Attention Required") ||
        (bodyText.includes("Cloudflare") && bodyText.includes("blocked"));

      // ── Structural markers (language-independent). Cloudflare localises the
      // interstitial ("请稍候…"), and the modern challenge carries none of the legacy
      // #challenge-running markup — its ids are random (cf-chl-widget-kjlr4_response).
      //
      // They must be FALSE for a page that merely EMBEDS a Turnstile: a login form with a
      // widget loads the same script and has the same response input. The site's OWN
      // content is the discriminator — an interstitial renders only the challenge, never
      // the app's form or nav. Getting this backwards routes every embedded/popup widget
      // into the full-page bypass, which never clicks them.
      const siteContent = document.querySelector(
        "input[type='password'], form[action*='login'], input[name='email'], input[name='username'], nav, header",
      );
      const marker =
        !siteContent &&
        !!document.querySelector(
          'input[id^="cf-chl-widget-"][id$="_response"], [name="cf-turnstile-response"], ' +
            'script[src*="challenges.cloudflare.com"], [id^="cf-chl-widget"]',
        );

      // ── Legacy overlay markup, still used by older challenge pages.
      const legacy = [
        "#challenge-running",
        "#cf-challenge-running",
        ".cf-browser-verification",
        "#challenge-overlay",
        "#cf-wrapper #challenge-body",
      ].some((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      // ── Is there a CLICKABLE box on screen? The modern widget has no
      // challenges.cloudflare.com <iframe> in the light DOM (its response input is there
      // instead), so an iframe-only test misses it and the challenge falls through to the
      // wait-only branch — a full-page checkbox that never gets clicked.
      const resp = document.querySelector(
        'input[id^="cf-chl-widget-"][id$="_response"], input[name="cf-turnstile-response"]',
      );
      const box = (resp && resp.parentElement) || document.querySelector(".cf-turnstile");
      let visibleWidget = false;
      if (box) {
        const r = box.getBoundingClientRect();
        visibleWidget = r.width > 0 && r.height > 0;
      }

      const turnstileIframe = Array.from(document.querySelectorAll("iframe")).some((f) =>
        ["challenges.cloudflare.com", "cf-turnstile"].some((pat) => (f.src ?? "").includes(pat)),
      );

      return { blocked, marker, legacy, title, visibleWidget, turnstileIframe };
    })) as CfPageProbe;
  } catch {
    // page may have been closed / navigating
  }

  if (!probe) return "none";
  if (probe.blocked) {
    logger.warn("Cloudflare WAF block detected — IP/fingerprint is blocked");
    return "waf_blocked";
  }

  const titleMatch =
    probe.title === "Just a moment..." ||
    probe.title === "Attention Required! | Cloudflare" ||
    probe.title.includes("DDoS protection by Cloudflare");

  if (!(probe.marker || titleMatch || probe.legacy)) return "none";

  // From here on it is a FULL-PAGE challenge (embedded/popup widgets returned "none" via
  // the site-content guard and are handled by the token path). A visible box means there
  // is something to click; otherwise it is a self-verifying challenge we can only wait on.
  if (probe.visibleWidget) return "turnstile_click";

  // Turnstile renders its iframe inside a CLOSED shadow root, so the DOM scan above can
  // miss it — Playwright's frames() sees through shadow boundaries.
  try {
    if (page.frames().some((f: { url(): string }) => CF_FRAME_PATTERNS.some((p) => f.url().includes(p)))) {
      return "turnstile_click";
    }
  } catch {
    // frames() may not be available on every adapter
  }
  return probe.turnstileIframe ? "turnstile_click" : "js_challenge";
}

// ── Turnstile solved state check ────────────────────────────────────────────
// Ported from reference project's _SOLVED_JS.
// Checks if the Turnstile hidden input already has a valid token.

async function isTurnstileSolved(page: PageAdapter): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // Embedded widgets use name="cf-turnstile-response"; the modern full-page
      // interstitial instead fills input#cf-chl-widget-<random>_response. Checking
      // only the former meant a passed full-page challenge never looked solved.
      const els = document.querySelectorAll<HTMLInputElement>(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], ' +
          'input[id^="cf-chl-widget-"][id$="_response"]',
      );
      for (const el of Array.from(els)) {
        if (el.value && el.value.length > 20) return true;
      }
      return false;
    }) as boolean;
  } catch {
    return false;
  }
}

// ── Human behaviour simulation ───────────────────────────────────────────────

/**
 * Interpolate points along a quadratic Bézier curve.
 * Adds a random control point to make the path look organic.
 */
function bezierPath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  steps: number,
): Array<{ x: number; y: number }> {
  const cx = x0 + (x1 - x0) * 0.3 + (Math.random() - 0.5) * 120;
  const cy = y0 + (y1 - y0) * 0.7 + (Math.random() - 0.5) * 120;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const mt = 1 - t;
    return {
      x: Math.round(mt * mt * x0 + 2 * mt * t * cx + t * t * x1),
      y: Math.round(mt * mt * y0 + 2 * mt * t * cy + t * t * y1),
    };
  });
}

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min) + min);

/**
 * Simulate human-like mouse movement across the viewport.
 * Generates 4–8 bezier-curve paths with randomised speed.
 * This triggers mouse-event listeners that CF's JS challenge observes.
 */
export async function simulateHumanMouseMovement(page: PageAdapter): Promise<void> {
  const vp = page.viewport() ?? { width: 1280, height: 800 };

  // ── camoufox fast path ────────────────────────────────────────────────────
  // Camoufox's `humanize` interpolates the cursor INSIDE the browser (a single move can
  // take up to ~1.5 s of real, human-shaped motion). Feeding it the 49-200 move bezier
  // sweep below therefore costs MINUTES per call — with this function invoked several
  // times per bypass round, that alone burned the whole 30-minute task budget (the
  // "mouse.move ×97" failures). Two humanized moves give the same liveness signal.
  //
  // It is also the more useful signal: a cross-origin Turnstile iframe cannot see pointer
  // events that land on the host page at all, so sweeping the viewport was never what
  // convinced it — only the approach into the widget (humanClickAt) counts.
  if (await isFirefoxPage(page)) {
    try {
      await page.mouse.move(rand(vp.width * 0.25, vp.width * 0.65), rand(vp.height * 0.25, vp.height * 0.65));
      await sleep(rand(120, 260));
      await page.mouse.move(rand(vp.width * 0.35, vp.width * 0.75), rand(vp.height * 0.35, vp.height * 0.75));
    } catch { /* non-critical */ }
    return;
  }

  // ── cf-proxy fast path ────────────────────────────────────────────────────
  // On the SeleniumBase/cf-proxy backend EVERY mouse.move is a separate HTTP
  // round-trip to the sidecar, so a full bezier sweep (4-9 curves × 12-25 steps
  // = 100-200 moves) takes MINUTES and floods the logs — that is the main reason
  // a failing Turnstile login "takes forever". cf-proxy's native
  // uc_gui_click_captcha already produces human-like OS input, so here we just do
  // a couple of cheap moves for a liveness signal instead of a full sweep.
  if ("clickTurnstile" in page && typeof (page as unknown as { clickTurnstile?: unknown }).clickTurnstile === "function") {
    try {
      await page.mouse.move(rand(vp.width * 0.3, vp.width * 0.6), rand(vp.height * 0.3, vp.height * 0.6));
      await sleep(rand(80, 160));
      await page.mouse.move(rand(vp.width * 0.4, vp.width * 0.7), rand(vp.height * 0.4, vp.height * 0.7));
    } catch { /* non-critical */ }
    return;
  }

  let x = rand(vp.width * 0.1, vp.width * 0.9);
  let y = rand(vp.height * 0.1, vp.height * 0.9);
  await page.mouse.move(x, y).catch(() => {});
  await sleep(rand(150, 300));

  const moves = rand(4, 9);
  for (let i = 0; i < moves; i++) {
    const tx = rand(vp.width * 0.1, vp.width * 0.9);
    const ty = rand(vp.height * 0.1, vp.height * 0.9);
    const steps = rand(12, 25);
    const pts = bezierPath(x, y, tx, ty, steps);
    for (const pt of pts) {
      await page.mouse.move(pt.x, pt.y).catch(() => {});
      await sleep(rand(8, 25));
    }
    x = tx;
    y = ty;
    await sleep(rand(80, 350));
  }
}

/**
 * Simulate random page scrolling — CF and similar systems track scroll events
 * as a strong "human" signal.
 */
async function simulateHumanScroll(page: PageAdapter): Promise<void> {
  const scrollCount = rand(2, 5);
  for (let i = 0; i < scrollCount; i++) {
    const deltaY = rand(50, 300) * (Math.random() > 0.3 ? 1 : -1);
    await page.evaluate((dy: unknown) => {
      window.scrollBy({ top: dy as number, behavior: "smooth" });
    }, deltaY as never).catch(() => {});
    await sleep(rand(200, 600));
  }
}

/**
 * Combined human presence simulation.
 *
 * Keyboard simulation was REMOVED: it pressed Tab (which moves focus — Turnstile checks
 * document.hasFocus() and reacts to focus leaving the widget) and arrow keys (which
 * scroll). Both disturb a challenge that is mid-verification, which is a large part of
 * why the checkbox "kept spinning". Scrolling is likewise skipped once a widget is on the
 * page: moving the widget under the cursor both restarts it and invalidates coordinates
 * we are about to click.
 */
async function simulateHumanPresence(page: PageAdapter, opts?: { widgetPresent?: boolean }): Promise<void> {
  await simulateHumanMouseMovement(page);
  if (!opts?.widgetPresent && Math.random() < 0.5) await simulateHumanScroll(page);
}

// ── Turnstile checkbox click ──────────────────────────────────────────────────

/**
 * Locate the Cloudflare Turnstile iframe and click the "I am human" checkbox inside it.
 * Returns true if a click was successfully delivered.
 *
 * Strategy order:
 *   1. Expand hidden Turnstile iframes (port from JustRunMy.App reference)
 *   2. Physical OS-level click via xdotool (if available) — undetectable by CF
 *   3. CDP widget bounding box click (fallback)
 *   4. Cross-origin iframe element click (last resort)
 */
/**
 * Where the checkbox is, in main-frame viewport coordinates.
 *
 * Resolved in ONE evaluate, immediately before clicking, so nothing (a late layout shift,
 * a scroll) can make the coordinates stale. Covers all three shapes:
 *   • the Turnstile <iframe> when it is in the light DOM
 *   • an embedded widget container (.cf-turnstile / [data-sitekey])
 *   • the MODERN FULL-PAGE interstitial, whose container is a random id
 *     (#cf-chl-widget-xxx) with its iframe inside a CLOSED shadow root — neither
 *     `.cf-turnstile` nor `iframe[src*=…]` can see it, which is why those challenges sat
 *     on screen unclicked.
 */
async function locateTurnstileCheckbox(page: PageAdapter): Promise<{ x: number; y: number } | null> {
  try {
    return (await page.evaluate(() => {
      // The checkbox is a FIXED ~24px control after ~13px of padding, so its centre is
      // ~30px from the widget's left edge whatever the widget's width is. A proportional
      // offset lands in the padding and reads as "verification failed".
      const point = (r: DOMRect) => ({
        x: Math.round(r.x + Math.min(Math.max(r.width - 8, 8), 30)),
        y: Math.round(r.y + r.height / 2),
      });
      const usable = (r: DOMRect) => r.width >= 20 && r.height >= 16;

      for (const f of Array.from(document.querySelectorAll("iframe"))) {
        const src = f.src || "";
        if (!/cloudflare|turnstile|challenges/.test(src)) continue;
        const r = f.getBoundingClientRect();
        if (usable(r)) return point(r);
      }
      const resp = document.querySelector(
        'input[name="cf-turnstile-response"], input[id^="cf-chl-widget-"][id$="_response"]',
      );
      const candidates: Element[] = [];
      if (resp?.parentElement) candidates.push(resp.parentElement);
      candidates.push(...Array.from(document.querySelectorAll(".cf-turnstile, [data-sitekey], [id^='cf-chl-widget']")));
      for (const c of candidates) {
        const r = c.getBoundingClientRect();
        if (usable(r)) return point(r);
      }
      return null;
    })) as { x: number; y: number } | null;
  } catch {
    return null;
  }
}

/**
 * Wait for the click to be judged.
 *
 * Turnstile takes 1-4 s (sometimes more) to issue its token after a good click. The old
 * code waited 500 ms, concluded "not solved", and clicked AGAIN from the next strategy —
 * a second click on a widget that is mid-verification is exactly what turns it into
 * "Verification failed". So: one click, then poll patiently, and never re-click here.
 */
async function waitForTurnstileSettled(page: PageAdapter, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let round = 0;
  while (Date.now() < deadline) {
    await sleep(700);
    round++;
    // Cheap poll: ONE evaluate looking for the token. Deliberately not running the full
    // detectCfChallenge (4-6 evaluates) every round — hammering the page with scripts
    // while CF is watching is itself a signal, which is the mistake the JS-challenge
    // loop already learned. The expensive check runs every ~3 s, for the full-page case
    // where passing produces no token and the challenge simply disappears.
    if (await isTurnstileSolved(page)) return true;
    if (round % 4 === 0 && (await detectCfChallenge(page)) === "none") return true;
  }
  return (await isTurnstileSolved(page)) || (await detectCfChallenge(page)) === "none";
}

export async function clickTurnstileCheckbox(page: PageAdapter): Promise<boolean> {
  try {
    // ── SeleniumBase shortcut: use cf-proxy's native Turnstile clicker ──
    // cf-proxy has access to uc_gui_click_captcha (PyAutoGUI) and xdotool,
    // which produce OS-level events undetectable by CF.
    if ("clickTurnstile" in page && typeof (page as any).clickTurnstile === "function") {
      logger.info("Using cf-proxy native Turnstile click (uc_gui_click_captcha + xdotool)");
      const solved = await (page as any).clickTurnstile(2);
      logger.info({ solved }, "cf-proxy native Turnstile click finished");
      // Do NOT fall through to the Node xdotool/CDP strategies below on the
      // cf-proxy backend: the browser + X display live in the cf-proxy container,
      // so THIS app container's xdotool has no DISPLAY ("Can't open display") and
      // CDP coordinate clicks miss (the generic /mouse/click adds no window/
      // title-bar offset). Native is the only correct path here — returning its
      // result avoids ~minutes of doomed retries spamming xdo errors.
      return solved;
    }
    // ── Step 0: un-clip the widget, but only if it actually needs it ────
    await expandTurnstileIfClipped(page);

    // ── Step 1: Physical OS-level click via xdotool ─────────────────────
    // Only ever true for the local/patchright backend, whose Chromium runs on THIS
    // container's Xvfb. (The shipped image has no X server at all, and camoufox's Firefox
    // lives in another container — deliberately: OS-level clicking there would make every
    // concurrent session fight over one shared cursor, the exact race cf-proxy has.)
    if (isXdotoolAvailable()) {
      const clicked = await physicalClickTurnstile(page);
      if (clicked) return true;
    }

    // ── Step 2: ONE well-formed click, then wait for the verdict ────────
    // Turnstile must be focused to complete, and the click must look like a hand:
    // approach, dwell, press for 60-140 ms, release. Coordinates are resolved right
    // here so a late layout shift cannot make them stale.
    await ensureFocused(page, "turnstile-click");

    // Prefer the checkbox element inside the CF frame (frames() sees through the closed
    // shadow root that DOM queries cannot); fall back to widget geometry.
    let target: { x: number; y: number } | null = null;
    const cfFrame = page
      .frames()
      .find((f: { url(): string }) => CF_FRAME_PATTERNS.some((p) => f.url().includes(p)));
    if (cfFrame) {
      const checkbox = await cfFrame
        .$("input[type='checkbox'], .cb-lb input, .cf-checkbox-label, #challenge-stage input, .mark")
        .catch(() => null);
      const box = checkbox ? await checkbox.boundingBox().catch(() => null) : null;
      if (box && box.width > 0 && box.height > 0) {
        target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    }
    if (!target) target = await locateTurnstileCheckbox(page);
    if (!target) {
      logger.warn({ widget: await describeTurnstileState(page) }, "Turnstile widget is on the page but its checkbox could not be located");
      return false;
    }

    // ±2px of jitter — a pixel-exact centre every time is itself a pattern.
    const x = target.x + (Math.random() * 4 - 2);
    const y = target.y + (Math.random() * 4 - 2);
    logger.info({ x: Math.round(x), y: Math.round(y), viaFrame: !!cfFrame }, "Clicking Turnstile checkbox");
    await humanClickAt(page, x, y);

    // Patience, and NO second click: re-clicking a widget that is still verifying is what
    // produces "Verification failed" (and it used to happen ~1 s after a good click).
    const settled = await waitForTurnstileSettled(page, Number(process.env.CF_TOKEN_WAIT_MS ?? 12_000));
    // On failure, say WHAT the box shows. "Verify you are human" means the click missed;
    // "Verifying…" means it is still working and we gave up too early; "Verification
    // failed" means the click landed but was judged a bot. Three different fixes.
    logger.info(
      { settled, ...(settled ? {} : { widget: await describeTurnstileState(page) }) },
      "Turnstile click settled",
    );
    return settled;
  } catch (err) {
    logger.debug({ err }, "Turnstile click failed");
    return false;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Attempt to bypass an active Cloudflare challenge page.
 *
 * Returns:
 *   "passed"        — challenge cleared, page is now usable
 *   "failed"        — challenge not cleared after all attempts
 *   "not_detected"  — no CF challenge was found on the page
 */
export async function bypassCloudflareChallenge(
  page: PageAdapter,
  opts?: { deadline?: number },
): Promise<"passed" | "failed" | "blocked" | "not_detected"> {
  const challengeType = await detectCfChallenge(page);
  if (challengeType === "none") return "not_detected";
  if (challengeType === "waf_blocked") return "blocked";

  logger.info({ challengeType }, "Cloudflare challenge detected — attempting bypass");

  // Inject CF-specific environment patches before interacting.
  // These make the browser look more like a real user session to CF's JS probes.
  // Chromium-only — see injectCfEnvironmentPatches.
  await injectCfEnvironmentPatches(page);

  // Expand hidden Turnstile iframes — once, and only when they are actually clipped.
  await expandTurnstileIfClipped(page);

  // Quick check: Turnstile may have already been solved silently
  const alreadySolved = await isTurnstileSolved(page);
  if (alreadySolved) {
    logger.info("Turnstile already solved silently (token present)");
    return "passed";
  }

  if (challengeType === "js_challenge") {
    // A non-interactive / "managed" challenge VERIFIES ITSELF and issues its token
    // within SECONDS — if it hasn't cleared in ~30s it isn't going to (the IP/
    // fingerprint is being refused), and waiting longer just keeps probing the page
    // with execute_script during CF's watch window, which itself trips detection.
    // A page that clears exits immediately (detectCfChallenge → "none"); the cap only
    // bounds the give-up time on a genuine failure. Tunable via CF_JS_DEADLINE_MS.
    const jsDeadline = opts?.deadline ?? Date.now() + Number(process.env.CF_JS_DEADLINE_MS ?? 30_000);
    let attempt = 0;
    while (Date.now() < jsDeadline) {
      attempt++;
      // NOTE: no re-expansion and no keyboard/scroll here. A non-interactive challenge is
      // verifying in the background; every DOM mutation we make restarts it, which is how
      // "it just kept spinning" happened. Wait quietly, with a little pointer motion.
      await simulateHumanPresence(page);
      await sleep(attempt === 1 ? 4_000 + Math.random() * 2_000 : 3_000 + Math.random() * 1_500);

      const still = await detectCfChallenge(page);
      if (still === "none") {
        logger.info({ attempt }, "Cloudflare JS challenge verified/cleared");
        return "passed";
      }
      if (await isTurnstileSolved(page)) {
        logger.info({ attempt }, "Turnstile token populated while waiting");
        return "passed";
      }
      // If it upgraded to an interactive checkbox, click it — once. clickTurnstileCheckbox
      // now waits for the verdict itself, so there is nothing to re-check here.
      if (still === "turnstile_click") {
        logger.info({ attempt }, "JS challenge upgraded to Turnstile click — attempting click");
        await simulateHumanPresence(page, { widgetPresent: true });
        await sleep(500 + Math.random() * 500);
        if (await clickTurnstileCheckbox(page)) {
          logger.info({ attempt }, "Cloudflare challenge bypassed after click");
          return "passed";
        }
      }
      logger.debug({ attempt }, "CF JS challenge still verifying, waiting");
    }
    logger.warn({ attempt }, "Cloudflare JS challenge did not clear before the deadline");
    return "failed";
  }

  if (challengeType === "turnstile_click") {
    // ONE clean click per bypass round.
    //
    // clickTurnstileCheckbox now owns the whole sequence — focus, a human-shaped press,
    // and up to ~12 s of waiting for the token / the challenge to disappear — so there is
    // nothing left to re-check or re-try out here. Re-clicking a widget that is still
    // verifying is precisely what turns it into "Verification failed": that is what the
    // old 3-attempt loop (each attempt re-expanding the widget, then clicking again ~1 s
    // after the previous click) was doing to challenges that had actually been passed.
    //
    // If a clean click does not pass, the answer is a FRESH page (the caller reloads) or a
    // different exit IP — not more clicks on the same widget.
    await simulateHumanPresence(page, { widgetPresent: true });
    await sleep(600 + Math.random() * 900);

    const clicked = await clickTurnstileCheckbox(page);
    if (clicked) {
      logger.info("Cloudflare Turnstile click challenge bypassed");
      return "passed";
    }

    // A full-page challenge passes with NO token — it just navigates away — and the
    // cf-proxy native clicker cannot see that, so confirm independently before failing.
    if ((await detectCfChallenge(page)) === "none" || (await isTurnstileSolved(page))) {
      logger.info("Cloudflare full-page challenge cleared after click");
      return "passed";
    }

    // It may still be finishing a slow verification: give it one quiet grace period
    // (no clicking, no DOM changes) before giving up.
    await sleep(3_000 + Math.random() * 2_000);
    if ((await detectCfChallenge(page)) === "none" || (await isTurnstileSolved(page))) {
      logger.info("Cloudflare Turnstile cleared during the grace period");
      return "passed";
    }
    logger.warn("Cloudflare Turnstile click challenge not bypassed — needs a fresh page or a different exit IP");
    return "failed";
  }

  return "failed";
}

/**
 * Ensure a full-page Cloudflare interstitial ("Just a moment…" / managed /
 * non-interactive challenge) is cleared *before* the caller tries to interact
 * with the real page (find a login form, click a button, etc.).
 *
 * This mirrors the cf-proxy (SeleniumBase UC) login flow, where every
 * navigation goes through `uc_open_with_reconnect()` so Cloudflare sees a
 * clean browser during the challenge window. For the Playwright / Puppeteer /
 * local backends we cannot disconnect CDP, so instead we:
 *
 *   1. Run the standard bypass (human presence + Turnstile checkbox click).
 *   2. If it does not clear, **reload the page** and retry — a fresh navigation
 *      is the closest analogue to uc_open_with_reconnect and frequently lets a
 *      stalled non-interactive / managed challenge finish.
 *
 * Returns:
 *   true  — no CF interstitial present, or it was cleared.
 *   false — a challenge is still blocking the page (WAF block or unsolved).
 *
 * IMPORTANT: this is safe to call on any page. If there is no CF challenge it
 * returns immediately, so callers can invoke it unconditionally after a goto.
 */
export async function clearCloudflareInterstitial(
  page: PageAdapter,
  opts?: { url?: string; maxReloads?: number; budgetMs?: number },
): Promise<boolean> {
  const maxReloads = opts?.maxReloads ?? 2;
  // Wall-clock budget for the WHOLE clear. A full-page interstitial that is going to
  // clear does so within seconds; if it hasn't cleared in ~60s the IP/fingerprint is
  // being refused and more waiting only keeps probing the page (a detection tell) and
  // drags a failing login out for minutes. A page that clears exits immediately, so
  // this cap only bounds the give-up time on genuine failure. Tunable via
  // CF_CLEAR_BUDGET_MS.
  const budgetMs = opts?.budgetMs ?? Number(process.env.CF_CLEAR_BUDGET_MS ?? 60_000);
  const deadline = Date.now() + budgetMs;

  // This function clears FULL-PAGE interstitials — the ones that block the page and
  // redirect when passed. An embedded Turnstile that sits inside a login form is NOT
  // one of those: it never redirects (it just ticks + issues a token), so trying to
  // "clear" it here loops to the budget and reports failure, and the form never gets
  // filled. If the page already shows its login form, there is no interstitial to
  // pre-clear — leave the embedded widget to the before-submit captcha handling.
  const hasLoginForm = (await page
    .evaluate(() =>
      !!document.querySelector("input[type='password'], input[name='email'], input[name='username']"),
    )
    .catch(() => false)) as boolean;
  if (hasLoginForm) {
    logger.info("Login form already present — no full-page interstitial to clear (embedded widget handled before submit)");
    return true;
  }

  for (let round = 0; round <= maxReloads; round++) {
    if (Date.now() > deadline) {
      logger.warn({ round, budgetMs }, "Cloudflare interstitial clear exceeded its time budget — aborting");
      return false;
    }
    const result = await bypassCloudflareChallenge(page, { deadline });
    if (result === "not_detected" || result === "passed") {
      if (round > 0) logger.info({ round }, "Cloudflare interstitial cleared after reload");
      return true;
    }
    if (result === "blocked") {
      logger.warn("Cloudflare WAF block — cannot clear interstitial by browser bypass");
      return false;
    }

    // result === "failed" — reload and retry (analogue of uc_open_with_reconnect).
    // But NOT if a non-interactive challenge is still verifying: reloading restarts
    // its spinner from scratch and it never gets to finish. bypassCloudflareChallenge
    // already waited to the deadline for that case, so if we're still on a js_challenge
    // the reload wouldn't help — only an interactive/stuck one benefits from a fresh
    // navigation.
    const stillType = await detectCfChallenge(page).catch(() => "js_challenge" as const);
    if (stillType === "js_challenge") {
      logger.warn("CF non-interactive challenge still verifying at deadline — a reload would only restart it");
      return false;
    }
    if (round < maxReloads) {
      const reloadUrl = opts?.url || page.url();
      logger.info({ round, reloadUrl }, "CF interstitial not cleared — reloading page and retrying");
      try {
        await page.goto(reloadUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch {
        // Navigation may be interrupted by the challenge redirect — ignore.
      }
      // Give CF's JS a moment to spin up before the next bypass round.
      await sleep(2_500 + Math.random() * 1_500);
    }
  }

  // Final status check — the challenge may have cleared during the last wait.
  const finalType = await bypassCloudflareChallenge(page, { deadline });
  return finalType === "not_detected" || finalType === "passed";
}

// ── CF environment patches ───────────────────────────────────────────────────

/**
 * Inject runtime patches that specifically target CF's JS challenge probes.
 * These are separate from the general stealth script because they should
 * only run when a CF challenge is actually detected.
 */
async function injectCfEnvironmentPatches(page: PageAdapter): Promise<void> {
  // CHROMIUM ONLY. Every patch below describes a Chromium environment: the Network
  // Information API (navigator.connection) does not exist in Firefox at all, so adding it
  // to a Firefox UA is a straight contradiction — and camoufox's whole value is an
  // internally consistent Firefox. Overwriting performance.now is worse: a native function
  // whose toString no longer looks native, injected at exactly the moment CF is probing.
  if (await isFirefoxPage(page)) {
    logger.debug("Firefox/camoufox — skipping Chromium-only CF environment patches");
    return;
  }
  try {
    await page.evaluate((() => {
      // CF checks window.navigator.connection — simulate a typical broadband connection
      // @ts-ignore
      if (!navigator.connection) {
        Object.defineProperty(navigator, "connection", {
          get: () => ({
            effectiveType: "4g",
            rtt: 50,
            downlink: 10,
            saveData: false,
          }),
        });
      }
      // CF may probe Notification.permission
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Object.defineProperty(Notification, "permission", { get: () => "default", configurable: true });
        }
      } catch {}
      // Inject realistic performance timing entries
      try {
        if (performance.getEntriesByType("navigation").length === 0) {
          // Can't add entries, but ensure performance.now() has realistic offset
          const origNow = performance.now.bind(performance);
          const offset = Math.random() * 100;
          performance.now = () => origNow() + offset;
        }
      } catch {}
    }) as unknown as string).catch(() => {});
  } catch {
    // Non-critical — continue with bypass
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
