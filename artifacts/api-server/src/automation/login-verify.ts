import type { PageAdapter } from "./page-adapter";

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
export type LoginVerdict = "logged_in" | "logged_out" | "unknown";

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
