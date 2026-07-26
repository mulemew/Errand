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
    await el.click();
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
