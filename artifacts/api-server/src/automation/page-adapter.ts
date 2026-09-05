/**
 * PageAdapter — unified browser page interface for both Puppeteer and Playwright.
 *
 * Both providers connect to a remote CDP WebSocket (browserless, etc.).
 * This adapter normalises API differences so the rest of the codebase
 * stays provider-agnostic.
 */

import puppeteer, { type Page as PuppeteerPage, type Frame as PuppeteerFrame } from "puppeteer";
import { chromium, firefox, type Page as PlaywrightPage, type Frame as PlaywrightFrame } from "playwright-core";

// ── Adapter interfaces ────────────────────────────────────────────────────────

export interface ElementAdapter {
  click(): Promise<void>;
  evaluate<T>(fn: (el: Element) => T): Promise<T>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  screenshot(options?: { encoding?: "base64" | "binary" }): Promise<Buffer | string>;
}

export interface DialogAdapter {
  dialogType(): string;
  message(): string;
  dismiss(): Promise<void>;
  accept(): Promise<void>;
}

export interface KeyboardAdapter {
  type(text: string, options?: { delay?: number }): Promise<void>;
  press(key: string): Promise<void>;
}

export interface MouseAdapter {
  move(x: number, y: number): Promise<void>;
  /** `delay` holds the button down for a human-length time; without it mousedown and
   *  mouseup land in the same millisecond, which Turnstile scores as a bot. Preferred over
   *  down()/up() because the press is bound to EXPLICIT coordinates — see humanClickAt. */
  click(x: number, y: number, opts?: { delay?: number }): Promise<void>;
  /** Separate press/release. Note these take no coordinates: they act wherever the cursor
   *  currently is, which is only knowable if nothing else moves it.
   *  Optional: the cf-proxy adapter drives the real OS mouse and has no equivalent. */
  down?(): Promise<void>;
  up?(): Promise<void>;
}

export interface FrameAdapter {
  url(): string;
  $(selector: string): Promise<ElementAdapter | null>;
}

export interface PageAdapter {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  // `timeout` caps the ACTIONABILITY wait — how long the driver waits for an
  // already-located element to become visible/stable/hit-testable — not the time
  // spent finding it. Callers that have a working fallback should pass a short one:
  // the default is NAV_TIMEOUT_MS (60 s), and two clicks stuck on it are enough to
  // blow a login's whole attempt budget without ever reporting why.
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  hover(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForNavigation(options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  $(selector: string): Promise<ElementAdapter | null>;
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
  screenshot(options?: { type?: "png" | "jpeg"; encoding?: "base64" | "binary"; timeout?: number }): Promise<Buffer | string>;
  url(): string;
  title(): Promise<string>;
  on(event: "dialog", handler: (dialog: DialogAdapter) => void): void;
  close(options?: Record<string, unknown>): Promise<void>;
  keyboard: KeyboardAdapter;
  mouse: MouseAdapter;
  viewport(): { width: number; height: number } | null;
  frames(): FrameAdapter[];
  /** Wait for a new browser tab/window to open and return it as a PageAdapter. */
  waitForNewPage(options?: { timeout?: number }): Promise<PageAdapter>;
  /** Returns true if the underlying page has been closed / detached. */
  isClosed(): boolean;
  /**
   * Drop every cookie in this browser context.
   *
   * For the moment cookie mode has PROBED a restored session and found it dead. Those
   * cookies have no value from then on — we are about to log in from scratch — and they can
   * actively break that login: a server that binds its CSRF token to the session sees a
   * session it does not recognise and answers "CSRF token mismatch", which is not a thing a
   * human hits because a human arrives with no session at all.
   *
   * Optional: the cf-proxy adapter has no equivalent.
   */
  clearCookies?(): Promise<void>;
  /** Raise/activate this page's window. Turnstile checks document.hasFocus(), and the
   *  camoufox sidecar runs every concurrent session's headful Firefox on ONE Xvfb — so
   *  without this only one window is focused and the rest fail the interactive check.
   *  Optional: not available on the cf-proxy adapter. */
  bringToFront?(): Promise<void>;
  /**
   * Returns all currently open non-closed pages in the same browser context.
   * Screenshot step uses this to auto-fallback when the current page is closed
   * (e.g. a click opened a new tab without a switchToNewPage step).
   */
  getOpenPages(): PageAdapter[];
  /**
   * Open another tab in the same browser context.
   *
   * Not `provider.newPage()`, which for camoufox means "connect, make a context, make a
   * page" — calling that again gives you a second BROWSER. Optional: only the Playwright
   * wrapper can do it, and only the camoufox backend needs it.
   */
  openTab?(url?: string): Promise<PageAdapter>;
  /**
   * Every page in the whole BROWSER, not just this page's context.
   *
   * getOpenPages asks the context, and a tab the person opened themselves — Ctrl+T in the
   * window they are looking at — does not necessarily land in the context automation
   * created. Measured: a session with several tabs open reported exactly one page.
   *
   * Safe to widen here because a hand-driven browser is its own camoufox session with its
   * own Firefox and its own ws endpoint, so "the whole browser" is still just this one.
   */
  getAllPages?(): PageAdapter[];
}

// ── Puppeteer wrapper ─────────────────────────────────────────────────────────

/**
 * Puppeteer uses `::-p-xpath(expr)` for XPath; Playwright uses `xpath=expr`.
 * Callers always pass `xpath=expr` — this function converts for Puppeteer.
 */
function toPuppeteerSelector(sel: string): string {
  if (sel.startsWith("xpath=")) return `::-p-xpath(${sel.slice(6)})`;
  return sel;
}

function wrapPuppeteerFrameElement(
  el: Awaited<ReturnType<PuppeteerFrame["$"]>> & object,
  frame: PuppeteerFrame,
): ElementAdapter {
  return {
    click: () => el.click(),
    evaluate: <T>(fn: (e: Element) => T) => frame.evaluate(fn, el) as Promise<T>,
    boundingBox: () => el.boundingBox(),
    screenshot: async (opts) => {
      if (opts?.encoding === "base64") return el.screenshot({ encoding: "base64" }) as Promise<string>;
      return el.screenshot() as Promise<Buffer>;
    },
  };
}

function wrapPuppeteerElement(
  el: Awaited<ReturnType<PuppeteerPage["$"]>> & object,
  page: PuppeteerPage,
): ElementAdapter {
  return {
    click: () => el.click(),
    evaluate: <T>(fn: (e: Element) => T) => page.evaluate(fn, el) as Promise<T>,
    boundingBox: () => el.boundingBox(),
    screenshot: async (opts) => {
      if (opts?.encoding === "base64") return el.screenshot({ encoding: "base64" }) as Promise<string>;
      return el.screenshot() as Promise<Buffer>;
    },
  };
}

function wrapPuppeteerFrame(frame: PuppeteerFrame): FrameAdapter {
  return {
    url: () => frame.url(),
    $: async (sel) => {
      const el = await frame.$(toPuppeteerSelector(sel));
      if (!el) return null;
      return wrapPuppeteerFrameElement(el, frame);
    },
  };
}

export function wrapPuppeteerPage(page: PuppeteerPage): PageAdapter {
  const adapter: PageAdapter = {
    goto: async (url, opts) => {
      await page.goto(url, opts as Parameters<PuppeteerPage["goto"]>[1]);
    },
    // `timeout` is deliberately dropped here: Puppeteer's ClickOptions has no such
    // field, and it needs none — its click resolves the selector and clicks, without
    // Playwright's actionability retry loop, so there is no wait to cap.
    click: (sel) => page.click(toPuppeteerSelector(sel)),
    hover: (sel) => page.hover(toPuppeteerSelector(sel)),
    waitForSelector: async (sel, opts) => {
      await page.waitForSelector(toPuppeteerSelector(sel) as string, opts);
    },
    waitForNavigation: async (opts) => {
      await page.waitForNavigation(opts as Parameters<PuppeteerPage["waitForNavigation"]>[0]);
    },
    $: async (sel) => {
      const el = await page.$(toPuppeteerSelector(sel));
      if (!el) return null;
      return wrapPuppeteerElement(el, page);
    },
    evaluate: (fn: unknown, ...args: unknown[]) => page.evaluate(fn as never, ...args),
    screenshot: async (opts) => {
      if (opts?.encoding === "base64") {
        return page.screenshot({ ...opts, encoding: "base64" }) as unknown as string;
      }
      const buf = await page.screenshot(opts as Parameters<PuppeteerPage["screenshot"]>[0]);
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
    },
    url: () => page.url(),
    title: () => page.title(),
    on: (event, handler) => {
      if (event === "dialog") {
        page.on("dialog", (d) =>
          handler({
            dialogType: () => d.type(),
            message: () => d.message(),
            dismiss: () => d.dismiss(),
            accept: () => d.accept(),
          }),
        );
      }
    },
    close: (opts) => page.close(opts as Parameters<PuppeteerPage["close"]>[0]),
    keyboard: {
      type: (text, opts) => page.keyboard.type(text, opts),
      press: (key) => page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]),
    },
    mouse: {
      move: (x, y) => page.mouse.move(x, y),
      click: (x, y, opts) => page.mouse.click(x, y, opts),
      down: () => page.mouse.down(),
      up: () => page.mouse.up(),
    },
    bringToFront: () => page.bringToFront(),
    viewport: () => page.viewport(),
    frames: () => page.frames().map(wrapPuppeteerFrame),
    waitForNewPage: async (_opts) => {
      throw new Error("waitForNewPage must be initialised by the BrowserProvider");
    },
    isClosed: () => page.isClosed(),
      getOpenPages: () => [], // Puppeteer: browser.pages() is async; fallback not supported
    };
    return adapter;
  }

  // ── Playwright wrapper ────────────────────────────────────────────────────────

function normalizeWaitUntil(
  w?: string,
): "networkidle" | "domcontentloaded" | "load" | "commit" | undefined {
  if (w === "networkidle2" || w === "networkidle0" || w === "networkidle") return "networkidle";
  if (w === "domcontentloaded") return "domcontentloaded";
  if (w === "load") return "load";
  if (w === "commit") return "commit";
  return undefined;
}

function wrapPlaywrightFrame(frame: PlaywrightFrame): FrameAdapter {
  return {
    url: () => frame.url(),
    $: async (sel) => {
      try {
        const locator = frame.locator(sel).first();
        if ((await locator.count()) === 0) return null;
        return {
          click: () => locator.click(),
          evaluate: <T>(fn: (el: Element) => T) => locator.evaluate(fn) as Promise<T>,
          boundingBox: () => locator.boundingBox(),
          screenshot: async (opts) => {
            const buf = await locator.screenshot();
            if (opts?.encoding === "base64") return buf.toString("base64");
            return buf;
          },
        };
      } catch {
        return null;
      }
    },
  };
}

export function wrapPlaywrightPage(page: PlaywrightPage): PageAdapter {
  const adapter: PageAdapter = {
    goto: async (url, opts) => {
      await page.goto(url, {
        waitUntil: normalizeWaitUntil(opts?.waitUntil) ?? "load",
        timeout: opts?.timeout,
      });
    },
    click: (sel, opts) => page.click(sel, opts),
    hover: (sel) => page.locator(sel).first().hover(),
    waitForSelector: async (sel, opts) => {
      await page.waitForSelector(sel, opts);
    },
    waitForNavigation: async (opts) => {
      // This was `page.waitForURL("**")`, which is a NO-OP: waitForURL resolves as soon as
      // the CURRENT url matches the pattern, and "**" matches everything — so it returned
      // immediately without waiting for anything. Every caller that clicked something and
      // then "waited for navigation" was in fact judging the page before the browser had
      // moved: that is how the Google flow concluded "already authenticated" while still
      // sitting on the login screen, and why the GitHub state machine sometimes evaluated
      // its first tick against the pre-click page.
      const before = page.url();
      const waitUntil = normalizeWaitUntil(opts?.waitUntil) ?? "load";
      const timeout = opts?.timeout ?? 30_000;
      try {
        await Promise.race([
          // The usual case: we end up somewhere else.
          page.waitForURL((u) => u.toString() !== before, { waitUntil, timeout }),
          // A same-URL navigation (form POST that re-renders, a reload) never changes the
          // URL, so watch for the document load too — otherwise those would burn the full
          // timeout waiting for a change that is not coming.
          page.waitForEvent("load", { timeout }),
        ]);
      } catch {
        // Nothing navigated within the timeout — the caller decides what that means.
      }
    },
    $: async (sel) => {
      try {
        const locator = page.locator(sel).first();
        if ((await locator.count()) === 0) return null;
        return {
          click: () => locator.click(),
          evaluate: <T>(fn: (el: Element) => T) => locator.evaluate(fn) as Promise<T>,
          boundingBox: () => locator.boundingBox(),
          screenshot: async (opts) => {
            const buf = await locator.screenshot();
            if (opts?.encoding === "base64") return buf.toString("base64");
            return buf;
          },
        };
      } catch {
        return null;
      }
    },
    evaluate: (fn: unknown, ...args: unknown[]) => page.evaluate(fn as never, ...args),
    screenshot: async (opts) => {
      const buf = await page.screenshot({ type: opts?.type ?? "png" });
      if (opts?.encoding === "base64") return buf.toString("base64");
      return buf;
    },
    url: () => page.url(),
    title: () => page.title(),
    on: (event, handler) => {
      if (event === "dialog") {
        page.on("dialog", (d) =>
          handler({
            dialogType: () => d.type(),
            message: () => d.message(),
            dismiss: () => d.dismiss(),
            accept: () => d.accept(),
          }),
        );
      }
    },
    close: () => page.close(),
    keyboard: {
      type: (text, opts) => page.keyboard.type(text, opts),
      press: (key) => page.keyboard.press(key),
    },
    mouse: {
      move: (x, y) => page.mouse.move(x, y),
      click: (x, y, opts) => page.mouse.click(x, y, opts),
      down: () => page.mouse.down(),
      up: () => page.mouse.up(),
    },
    clearCookies: async () => { await page.context().clearCookies(); },
    bringToFront: () => page.bringToFront(),
    viewport: () => page.viewportSize(),
    frames: () => page.frames().map(wrapPlaywrightFrame),
    waitForNewPage: async (_opts) => {
      throw new Error("waitForNewPage must be initialised by the BrowserProvider");
    },
    isClosed: () => page.isClosed(),
      getOpenPages: () =>
        page
          .context()
          .pages()
          .filter((p) => !p.isClosed())
          .map((p) => wrapPlaywrightPage(p)),
      getAllPages: () => {
        const browser = page.context().browser();
        const contexts = browser ? browser.contexts() : [page.context()];
        return contexts.flatMap((c) => c.pages().filter((p) => !p.isClosed()).map((p) => wrapPlaywrightPage(p)));
      },
      openTab: async (url?: string) => {
        // A TAB, not a window.
        //
        // Measured against a live Camoufox, reading Firefox's own session store afterwards:
        //
        //   window.open(url)          -> a tab in the SAME window
        //   a target=_blank, clicked  -> a tab in the SAME window
        //   context.newPage()         -> a separate WINDOW
        //
        // A restored session made of separate windows looks like it lost every tab but one,
        // because the last window is stacked over the rest and that is all the live view
        // shows. Playwright has no "new tab" call for Firefox, so the tab is opened the way
        // a page opens one.
        //
        // No user gesture is arranged for it: Camoufox ships with the popup blocker off
        // (dom.disable_open_during_load=false), so a scripted open is not blocked.
        if (url) {
          try {
            const [tab] = await Promise.all([
              page.context().waitForEvent("page", { timeout: 20_000 }),
              page.evaluate((u) => {
                window.open(u, "_blank");
              }, url),
            ]);
            // Deliberately NOT waiting for it to load. The tab exists the moment the page
            // event fires, and the browser loads it like a browser does — alongside the
            // others. Waiting here made restoring a window serial: each tab's full page
            // load added to the wait before the next one even appeared.
            return wrapPlaywrightPage(tab);
          } catch {
            // Blocked after all, or the page would not run script (an error page, a
            // navigation mid-call). A window is worse than a tab and better than a lost tab.
          }
        }
        const tab = await page.context().newPage();
        if (url) {
          await tab
            .goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
            .catch(() => { /* a tab that will not load is still a tab */ });
        }
        return wrapPlaywrightPage(tab);
      },
    };
    return adapter;
  }

  // ── Re-export library clients for use in browser-provider ─────────────────────
export { puppeteer, chromium, firefox };
