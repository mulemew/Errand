/**
 * One definition of "does this page say we succeeded", shared by every login path.
 *
 * There were three, and they disagreed in ways that cost real runs:
 *
 *   form login      polled for 25s and compared with whitespace collapsed + lowercased
 *   cookie probe    polled for 8s but compared RAW — so the same page that satisfied the
 *                   form path failed the probe, the task decided it was logged out, and
 *                   logged in again on top of a perfectly good session
 *   Google login    did not poll at all: one look 1.5s after landing, compared raw. A
 *                   login that had genuinely succeeded was reported as failed, the step
 *                   was retried against a site that was now signed in (so there was no
 *                   OAuth button to find), and the session was never saved — which is why
 *                   the same task re-ran the whole Google flow, TOTP included, every day.
 *
 * WHAT COUNTS AS A MATCH, and why each rule is here:
 *
 *  1. innerText, and textContent as well. innerText is the RENDERED text: an element that
 *     is in the DOM but not yet laid out contributes nothing to it. textContent has no such
 *     condition. Checking both costs one extra property read and removes a whole class of
 *     "the words are right there on my screen" failures.
 *
 *  2. Whitespace collapsed and case ignored. A needle typed with a double space, or a page
 *     that wraps mid-phrase, is not a different phrase.
 *
 *  3. Then, only if that fails, whitespace removed ENTIRELY from both sides. This one is
 *     not hypothetical: minestrator's header renders
 *
 *         <span class="mr-1">future</span><span>MyBox</span>
 *
 *     which LOOKS like "your future MyBox" and reads as "your futureMyBox" — the gap is a
 *     CSS margin, not a character. No timeout and no polling could ever have matched the
 *     phrase a person copies off that screen. Stripping whitespace on both sides makes it
 *     match, and cannot make an absent phrase present: it only ever adds matches that the
 *     other two rules already tried and missed.
 */
import type { PageAdapter } from "./page-adapter";

/** How long a success criterion gets to show up before we call it absent. */
// 25s, not 10. The criterion describes the page login LANDS on, and a panel's landing page
// fetches its content after it renders: control.heavencloud.in reached the dashboard, the
// URL proved it, and the text the operator was waiting for arrived after we had already
// called the login a failure — then retried it twice more against a session that was
// working perfectly. Matching returns immediately, so this is only ever spent on a run
// that was going to fail anyway.
export const CRITERION_WAIT_MS = Math.max(2000, Number(process.env.LOGIN_CRITERION_WAIT_MS ?? 25_000));

const collapse = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const strip = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** Both readings of the page's text: what is rendered, and what is merely present. */
async function readPageText(page: PageAdapter): Promise<{ rendered: string; present: string }> {
  return (await page
    .evaluate(() => {
      const b = document.body;
      return { rendered: b?.innerText ?? "", present: b?.textContent ?? "" };
    })
    .catch(() => ({ rendered: "", present: "" }))) as { rendered: string; present: string };
}

/**
 * Shortest needle allowed to use the whitespace-stripped comparison.
 *
 * Removing whitespace makes "log in" and "login" the same string — and those two are
 * exactly what distinguishes a signed-in page from a signed-out one, so a criterion of
 * "login" would start reporting success on the login page itself. Long phrases do not
 * collide like that by accident: this rule exists for `Welcome to your future MyBox`
 * (25 characters once stripped), not for single words.
 */
const MIN_STRIPPED_LEN = 8;

/** Does `haystack` contain `needle`, ignoring case, then ignoring whitespace entirely? */
export function textMatches(haystack: string, needle: string): boolean {
  const want = needle.trim();
  if (!want || !haystack) return false;
  if (collapse(haystack).includes(collapse(want))) return true;
  const bare = strip(want);
  if (bare.length < MIN_STRIPPED_LEN) return false;
  return strip(haystack).includes(bare);
}

/** One look: is the success text on the page right now? */
export async function pageHasSuccessText(page: PageAdapter, needle: string): Promise<boolean> {
  if (!needle?.trim()) return false;
  const { rendered, present } = await readPageText(page);
  return textMatches(rendered, needle) || textMatches(present, needle);
}

/** One look: is the success selector on the page and visible right now? */
export async function selectorIsVisible(page: PageAdapter, selector: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (!el) return false;
    return (await el.evaluate((e: Element) => {
      const style = window.getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    })) as boolean;
  } catch {
    // An invalid selector or a detached element is "not visible", not an error worth
    // failing a login over.
    return false;
  }
}

/**
 * Wait for the caller's own definition of success — their text, their selector, or either.
 *
 * Checked repeatedly rather than once, because the criterion describes the page login LANDS
 * on and that page usually arrives via a redirect: a single look immediately after submit
 * reports "not there" about a page that had not loaded yet.
 *
 * Returns the evidence, or "" if it never appeared.
 */
export async function waitForSuccessCriterion(
  page: PageAdapter,
  selector?: string,
  text?: string,
  maxMs = CRITERION_WAIT_MS,
): Promise<string> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (text?.trim() && (await pageHasSuccessText(page, text))) {
      return `Found the success text: "${text}"`;
    }
    if (selector?.trim() && (await selectorIsVisible(page, selector))) {
      return `The success selector "${selector}" is visible`;
    }
    if (Date.now() >= deadline) return "";
    await new Promise((r) => setTimeout(r, 500));
  }
}
