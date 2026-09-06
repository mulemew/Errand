import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";

/**
 * Clicks that cannot spend a whole login attempt being ignored.
 *
 * `page.click` waits for the element to be visible, stable and hit-testable and THEN
 * performs the click — and that last part can simply never return. Two production cases,
 * same signature in the log:
 *
 *     element is visible, enabled and stable / done scrolling / performing click action
 *
 * then sixty seconds of nothing. One was a renew button wired to a proof-of-work widget.
 * The other was GitHub's username field, which is why every GitHub OAuth login needed a
 * second attempt: the first burned 60s here, failed, and the retry sailed through because
 * the first attempt had already established the session. Whether a given click hangs is a
 * matter of timing, so the same code passed one run and failed the next.
 */

// Long enough that a slow page still gets its real, trusted click; short enough that a
// stuck one leaves room for the fallback and a retry inside the same attempt budget.
const REAL_CLICK_TIMEOUT_MS = 25000;

// Focus is cheaper to get right than a click, so it waits less before taking the other way.
const FOCUS_CLICK_TIMEOUT_MS = 8000;

/**
 * A real click, then a synthetic one if it does not land.
 *
 * The real click goes first because it is the trusted one — a synthetic `.click()` skips
 * the pointer events some widgets check. It just no longer gets a full minute to prove it
 * is stuck, and which one happened is reported to the caller so it can say so.
 */
export async function clickWithFallback(
  page: PageAdapter,
  selector: string,
): Promise<"real" | "synthetic"> {
  try {
    await page.click(selector, { timeout: REAL_CLICK_TIMEOUT_MS });
    return "real";
  } catch (err) {
    logger.warn(
      { selector, err: err instanceof Error ? err.message : String(err) },
      "Real click did not land — falling back to a synthetic click",
    );
    await page
      .evaluate((sel: string) => {
        const fn = (s: string): HTMLElement | null =>
          s.startsWith("xpath=")
            ? (document.evaluate(s.slice(6), document, null, 9, null)
                .singleNodeValue as HTMLElement | null)
            : document.querySelector<HTMLElement>(s);
        const el = fn(sel);
        if (el) el.click();
      }, selector as never)
      .catch(() => {});
    return "synthetic";
  }
}

/**
 * Put the caret in a field that is about to be typed into.
 *
 * These call sites never wanted a click for its own sake — the comment at one of them says
 * "click to focus the element before clearing and typing", and the real keyboard input that
 * follows is what the site actually checks. Paying a 60-second trusted-click timeout for a
 * caret is what cost GitHub logins their first attempt, so a click that will not land gives
 * way to `focus()` and the typing proceeds.
 */
export async function focusForTyping(
  page: PageAdapter,
  selector: string,
): Promise<"click" | "focus"> {
  try {
    await page.click(selector, { timeout: FOCUS_CLICK_TIMEOUT_MS });
    return "click";
  } catch (err) {
    logger.warn(
      { selector, err: err instanceof Error ? err.message : String(err) },
      "Click to focus did not land — focusing the field directly instead",
    );
    await page
      .evaluate((sel: string) => {
        const fn = (s: string): HTMLElement | null =>
          s.startsWith("xpath=")
            ? (document.evaluate(s.slice(6), document, null, 9, null)
                .singleNodeValue as HTMLElement | null)
            : document.querySelector<HTMLElement>(s);
        const el = fn(sel);
        if (el && typeof el.focus === "function") el.focus();
      }, selector as never)
      .catch(() => {});
    return "focus";
  }
}
