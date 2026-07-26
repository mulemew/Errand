import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";

/**
 * Navigate, and do not throw away a page that actually arrived.
 *
 * A Cloudflare interstitial re-navigates itself while it verifies, so the load state can
 * keep resetting and never settle inside the budget — page.goto then rejects with
 * "Timeout 60000ms exceeded" even though the challenge is right there on screen, rendered
 * and clickable. Every login flow treated that as fatal, so a site behind a full-page
 * challenge failed before anything was allowed to look at the page (and then burned two
 * more attempts doing it again).
 *
 * A timeout is therefore only fatal when the page is genuinely empty.
 */
export async function gotoTolerant(
  page: PageAdapter,
  url: string,
  timeout = 60_000,
): Promise<{ timedOut: boolean }> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return { timedOut: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/timeout/i.test(msg)) throw err;
    const alive = (await page
      .evaluate(() => ({
        ready: document.readyState,
        len: (document.body?.innerText ?? "").length,
        href: location.href,
      }))
      .catch(() => null)) as { ready: string; len: number; href: string } | null;
    if (!alive || (alive.len === 0 && alive.ready === "loading")) throw err;
    logger.warn(
      { url, landedOn: alive.href, readyState: alive.ready, textLength: alive.len },
      "Navigation timed out but the page has content (typical of a Cloudflare interstitial) — continuing",
    );
    return { timedOut: true };
  }
}

/**
 * Is this page showing us a LOGIN screen, or an authenticated one?
 *
 * Both OAuth flows used to conclude "already authenticated" from URL shape alone — "we are
 * not on github.com / accounts.google.com and the URL does not say /login, therefore we
 * must be in". That is true of a page where nothing happened at all: wispbyte serves its
 * login screen at /client, and an OAuth button that opens a popup (or a click that never
 * navigated) leaves us on exactly that URL. The run then reported success and every later
 * step executed logged out.
 *
 * So the verdict is taken from what is ON the page:
 *   "logged_out" — a visible password field, or a visible "sign in with …" affordance
 *   "logged_in"  — a visible sign-out / account affordance
 *   "unknown"    — neither; the caller decides how much benefit of the doubt to give
 *
 * Only VISIBLE elements count, and the login patterns must match a clickable element's own
 * text rather than the whole document, so a dashboard that merely mentions "login" in a
 * changelog is not mistaken for a login page.
 */
/**
 * Records how long each phase of a login took, and puts it in the failure message.
 *
 * Individual timeouts were all visible in the code, but a run that ended in "task timed out
 * after 30 min" said nothing about WHERE the time went — and with several 15-60 s waits per
 * attempt, the answer is never obvious from the outside. Now a failed login reports e.g.
 * `[goto 60.1s, cloudflare 92.4s, findButton 15.0s]`.
 */
export class PhaseTimer {
  private readonly marks: Array<[string, number]> = [];
  private last = Date.now();
  private readonly start = Date.now();

  mark(name: string): void {
    const now = Date.now();
    this.marks.push([name, now - this.last]);
    this.last = now;
  }

  /** "goto 60.1s, cloudflare 92.4s" — only phases that took over 100 ms. */
  summary(): string {
    const parts = this.marks
      .filter(([, ms]) => ms >= 100)
      .map(([n, ms]) => `${n} ${(ms / 1000).toFixed(1)}s`);
    const total = ((Date.now() - this.start) / 1000).toFixed(1);
    return parts.length ? `${parts.join(", ")}; total ${total}s` : `total ${total}s`;
  }

  /** Append the breakdown to a failure message. */
  annotate(message: string): string {
    return `${message} [${this.summary()}]`;
  }
}

export type LoginVerdict = "logged_in" | "logged_out" | "unknown";

/**
 * Click the first selector in the list that matches — trying them ONE AT A TIME, in the
 * order given.
 *
 * `page.$("a, b, c")` does NOT do this: it resolves to `locator(...).first()`, i.e. the
 * first match in DOCUMENT order, so a broad fallback selector at the end of the list can
 * win over the precise one at the front. That is how the Google flow clicked the app-name
 * button ("Continue to Pingless") instead of Next: `button[type='button']:not([disabled])`
 * matched it, and it sits earlier in the DOM than #identifierNext. The developer-info
 * dialog opened, nothing navigated, and the login died waiting for a password field.
 *
 * Returns the selector that was clicked, or null when none matched a visible element.
 */
export async function clickFirstMatching(page: PageAdapter, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    const visible = (await el
      .evaluate((e: Element) => {
        const r = e.getBoundingClientRect();
        const s = window.getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      })
      .catch(() => false)) as boolean;
    if (!visible) continue;
    // A click can still fail (covered by an overlay, detached mid-action). Fall through to
    // the next candidate instead of aborting the whole login — the old single-selector
    // call had no alternative to fall through TO, so this is strictly more forgiving.
    try {
      await el.click();
    } catch (err) {
      logger.debug({ sel, err }, "Candidate matched but the click failed — trying the next one");
      continue;
    }
    return sel;
  }
  return null;
}

/**
 * Click a button by its VISIBLE TEXT, matched against a list of localised labels.
 *
 * Provider sign-in pages are localised (the same Google page renders "Next" or "下一步"
 * depending on the exit IP's locale), so an English-only text match is not enough — and
 * matching on element structure instead is what caused the wrong-button click above.
 */
export async function clickButtonByText(page: PageAdapter, labels: string[]): Promise<string | null> {
  try {
    return (await page.evaluate((needles: unknown) => {
      const wanted = (needles as string[]).map((s) => s.toLowerCase());
      const els = Array.from(
        document.querySelectorAll<HTMLElement>("button, [role='button'], input[type='submit']"),
      );
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || s.visibility === "hidden" || s.display === "none") continue;
        const label = (
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          ""
        )
          .trim()
          .toLowerCase();
        if (!label) continue;
        // Exact-ish match only: "next" must not match "next time" or a nav item.
        if (wanted.some((w) => label === w || label.startsWith(w))) {
          el.click();
          return label;
        }
      }
      return null;
    }, labels as never)) as string | null;
  } catch {
    return null;
  }
}

/** Google sometimes opens an info dialog (app developer details) over the sign-in form.
 *  Anything we do underneath it is a no-op, so close it before continuing. */
export async function closeBlockingDialog(page: PageAdapter): Promise<boolean> {
  try {
    const open = (await page.evaluate(() => {
      const d = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'], [role='alertdialog'], dialog[open]"));
      return d.some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    })) as boolean;
    if (!open) return false;
    await clickButtonByText(page, ["got it", "ok", "close", "我知道了", "知道了", "确定", "確定", "关闭", "關閉"]);
    await page.keyboard.press("Escape").catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function detectLoginState(page: PageAdapter): Promise<{ verdict: LoginVerdict; evidence: string }> {
  try {
    return (await page.evaluate(() => {
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0.05;
      };
      const text = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);

      const pw = Array.from(document.querySelectorAll("input[type='password']")).find(visible);
      if (pw) return { verdict: "logged_out" as const, evidence: "visible password field" };

      const clickables = Array.from(
        document.querySelectorAll("a, button, [role='button'], input[type='submit']"),
      ).filter(visible);

      const LOGIN_RE =
        /(sign|log)\s?in\s+(with|via|using)|continue\s+(with|via)|(sign|log)\s?in\s+to|使用.{0,12}(登录|登陆)|通过.{0,12}(登录|登陆)|授权登录/i;
      const loginBtn = clickables.find((el) => LOGIN_RE.test(text(el)) || LOGIN_RE.test(el.getAttribute("aria-label") ?? ""));
      if (loginBtn) return { verdict: "logged_out" as const, evidence: `login button: "${text(loginBtn)}"` };

      const OUT_RE = /(sign|log)\s?out|logout|退出登录|注销|my account|dashboard/i;
      const outBtn = clickables.find((el) => OUT_RE.test(text(el)) || OUT_RE.test(el.getAttribute("aria-label") ?? ""));
      if (outBtn) return { verdict: "logged_in" as const, evidence: `account affordance: "${text(outBtn)}"` };

      return { verdict: "unknown" as const, evidence: "no login or account affordance found" };
    })) as { verdict: LoginVerdict; evidence: string };
  } catch {
    return { verdict: "unknown", evidence: "page not readable" };
  }
}

/**
 * Guard for the moment an OAuth flow wants to declare victory. Returns an error message
 * when the page still looks logged out, null when the claim is credible.
 *
 * `startUrl` is where we were BEFORE clicking the provider button: landing back on the
 * exact same URL is the signature of a click that opened a popup we never followed, or of
 * a click that did nothing at all.
 */
export async function verifyOAuthLanding(
  page: PageAdapter,
  provider: "GitHub" | "Google",
  startUrl?: string,
): Promise<string | null> {
  const { verdict, evidence } = await detectLoginState(page);
  if (verdict === "logged_out") {
    return `${provider} OAuth did not complete — the page still shows a login screen (${evidence}). URL: ${page.url()}`;
  }
  if (verdict === "unknown" && startUrl && page.url() === startUrl) {
    return (
      `${provider} OAuth did not complete — still on the page the flow started from and nothing indicates a session ` +
      `(${evidence}). If this site opens the provider in a popup window, add a "Switch to new page" step. URL: ${page.url()}`
    );
  }
  return null;
}
