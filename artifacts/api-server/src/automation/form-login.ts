import type { PageAdapter } from "./page-adapter";
  import { logger } from "../lib/logger";
  import { solveRecaptchaAudio } from "./recaptcha-audio";
  import { attachPopupHandler, dismissPopups } from "./popup-handler";
  import { detectAndHandleCaptcha } from "./captcha";
  import { clearCloudflareInterstitial, describeTurnstileState } from "./cloudflare-bypass";
  import { gotoTolerant, detectLoginState } from "./login-verify";
  import {
    CRITERION_WAIT_MS as SHARED_CRITERION_WAIT_MS,
    waitForSuccessCriterion as sharedWaitForSuccessCriterion,
  } from "./success-text";
  import { normalizeTotpSecret } from "../lib/totp";
  import type { CaptchaSolver } from "./captcha-solver";
  import crypto from "crypto";


  // ── TOTP helper (auto-fill 2FA screens after form submit) ──────────────────
  function decodeBase32(s: string): Buffer {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = "";
    for (const c of clean) {
      const v = alphabet.indexOf(c);
      if (v < 0) continue;
      bits += v.toString(2).padStart(5, "0");
    }
    const byteCount = Math.floor(bits.length / 8);
    const bytes = Buffer.alloc(byteCount);
    for (let i = 0; i < byteCount; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    return bytes;
  }

  function generateTOTP(secret: string, digits = 6, period = 30): string {
    // Normalise first: these decoders happen to skip stray characters, but the secret is
    // shared with flows that use a strict decoder, so they should all see the same value.
    const key = decodeBase32(normalizeTotpSecret(secret));
    const counter = Math.floor(Date.now() / 1000 / period);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hash = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hash[hash.length - 1] & 0x0f;
    const code =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      hash[offset + 3];
    return (code % 10 ** digits).toString().padStart(digits, "0");
  }

  export interface FormCredentials {
    username: string;
    password: string;
    /** Base32 TOTP secret — auto-fills 2FA screens after form submit */
    totpSecret?: string;
  }

  export interface LoginResult {
    success: boolean;
    captchaBlocked: boolean;
    message: string;
  }

  const USERNAME_SELECTORS = [
    "input[type='email']",
    "input[name='email']",
    "input[name='username']",
    "input[name='user']",
    "input[name='login']",
    "input[name='identifier']",
    "input[autocomplete='email']",
    "input[autocomplete='username']",
    "input[id*='email' i]",
    "input[id*='user' i]",
    "input[id*='login' i]",
    "input[placeholder*='email' i]",
    "input[placeholder*='username' i]",
    "input[type='text']",
  ];

  const PASSWORD_SELECTORS = [
    "input[type='password']",
    "input[name='password']",
    "input[name='pass']",
    "input[autocomplete='current-password']",
    "input[id*='pass' i]",
    "input[placeholder*='password' i]",
  ];

  /** Find a visible element matching one of the selectors, retrying for lazy-loaded SPAs. */
  async function findSelector(page: PageAdapter, selectors: string[], timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.evaluate((e: Element) => {
            const style = window.getComputedStyle(e);
            const rect = e.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
          });
          if (visible) return sel;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  /**
   * Wait for the page to settle after submitting a login form.
   * Polls until the URL stops changing for 1.5 s, or the deadline passes.
   */
  async function waitForSettle(page: PageAdapter, maxMs = 8000): Promise<void> {
    // Give the browser a moment to kick off any redirect before we start
    // measuring URL stability — without this a slow server-side redirect can
    // fool the loop into thinking the URL is already settled.
    await sleep(1000);
    const deadline = Date.now() + maxMs;
    let lastUrl = page.url();
    let stableFor = 0;
    const POLL = 400;
    const STABLE_THRESHOLD = 1500;

    while (Date.now() < deadline) {
      await sleep(POLL);
      const cur = page.url();
      if (cur === lastUrl) {
        stableFor += POLL;
        if (stableFor >= STABLE_THRESHOLD) return; // URL stable for 1.5 s → settled
      } else {
        lastUrl = cur;
        stableFor = 0; // URL still changing — reset
      }
    }
  }

  /**
   * Is the login form we just submitted STILL on the screen?
   *
   * The one signal that means "not logged in" no matter what else the page does. Everything
   * else here is circumstantial: a URL can change without a session being created, an error
   * can be rendered in markup we cannot recognise, a submit button can be swapped out for a
   * spinner. A password field you can still see and type into is none of those.
   *
   * Prefers the field locateLoginFields marked, which is the form we actually filled — a
   * reload wipes the mark, so any visible password field counts as the fallback.
   *
   * Returns the evidence, or "" when the form is gone (or the page is mid-navigation and
   * cannot be read, which is itself the shape of a login that worked).
   */
  async function loginFormEvidence(page: PageAdapter): Promise<string> {
    try {
      return (await page.evaluate(() => {
        const vis = (el: Element | null): boolean => {
          if (!el) return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = getComputedStyle(el as HTMLElement);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const marked = document.querySelector("input[data-wa-pass='1']");
        if (vis(marked)) return "the login form we filled is still on screen";
        const pw = Array.from(document.querySelectorAll("input[type='password']")).find(vis);
        if (pw) return "a password field is still visible";
        return "";
      })) as string;
    } catch {
      return "";
    }
  }

  /**
   * Watch the page from the moment of submit until the login resolves.
   *
   * Replaces "settle for a few seconds, then look once". Looking once loses a message that
   * is not there yet AND a message that is no longer there — the Pterodactyl/Arix theme
   * renders its login error as a toast that starts fading at 5.5 s, so a single read timed
   * anywhere outside that window sees a page with no error on it and no session either.
   *
   * Stops early on either verdict: an error message (nothing later can make that a success)
   * or the login form disappearing (which is the success shape, and stops us scanning a
   * dashboard for words that look like failures).
   */
  async function awaitLoginResolution(page: PageAdapter, maxMs = 12_000): Promise<{ error: string; formGone: boolean }> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const err = await readLoginError(page);
      if (err) return { error: err, formGone: false };
      if (!(await loginFormEvidence(page))) {
        // Let a redirect chain finish so the URL we report is the one it landed on.
        await waitForSettle(page, 4000);
        // Only elements that call themselves errors from here on. We are looking at the page
        // the login LANDED on, and phrase-matching a whole dashboard would eventually find a
        // node whose text reads like a failure — and turn a good login into a bad one.
        return { error: await readLoginError(page, false), formGone: true };
      }
      await sleep(400);
    }
    return { error: await readLoginError(page), formGone: !(await loginFormEvidence(page)) };
  }

  /** How long a success criterion gets to show up before we call it absent. See success-text.ts. */
  const CRITERION_WAIT_MS = SHARED_CRITERION_WAIT_MS;

  /**
   * Wait for the caller's own definition of success — their text, their selector, or either.
   *
   * Delegates to the shared implementation so that the form path, the cookie-mode probe and
   * the Google path cannot drift apart again. See success-text.ts for what counts as a match.
   */
  async function waitForSuccessCriterion(
    page: PageAdapter,
    selector?: string,
    text?: string,
    maxMs = CRITERION_WAIT_MS,
  ): Promise<string> {
    return sharedWaitForSuccessCriterion(page, selector, text, maxMs);
  }

  /**
   * Determine whether login succeeded by inspecting the page state.
   *
   * Only consulted when the caller gave NO success criterion of their own — when they did,
   * that answer is the whole verdict.
   *
   * Ordered so that success needs POSITIVE evidence. It used to be the other way round —
   * "the URL changed" and even "no error was recognised" were enough — and both are true of
   * a login that did nothing at all. A panel whose SPA redirects / → /auth/login on load
   * satisfies "URL changed" before a single credential is typed, so every failed attempt
   * against it was reported as `Successfully logged in. Navigated to: …/auth/login`.
   *
   * 1. The site said something went wrong          → failure
   * 2. The login form is still on screen           → failure
   * 3. URL left the login page                     → success
   * 4. An element that names itself an error       → failure
   * 5. A post-login element appeared               → success
   * 6. The submit control is gone                  → success
   */
  async function detectLoginOutcome(
    page: PageAdapter,
    targetUrl: string,
    successSelector?: string,
    submitSel?: string,
    successText?: string,
    submitError?: string,
    /**
     * The criterion was ALREADY satisfied on the login page, before anything was submitted.
     * Then it says nothing about whether we logged in — most often a site name or a nav item
     * that is on every page, including the one we are trying to leave — so it is ignored and
     * the heuristics below decide. Refusing outright would be wrong too: the login may well
     * have worked.
     */
    criterionWasAlreadyTrue?: boolean,
  ): Promise<{ success: boolean; reason: string }> {
    const normalize = (u: string) => u.replace(/\/+$/, "").split("?")[0].split("#")[0];

    // 0. The caller said what success looks like — so it decides, BOTH ways.
    //
    //    This used to be a positive signal only: present meant success, absent meant fall
    //    through to the guesswork below. Which makes the setting almost useless in the case
    //    people reach for it — someone who has already seen a false success sets a success
    //    text precisely to stop it, and absent-means-keep-guessing let the very next
    //    heuristic ("the URL changed") declare success anyway. A criterion that cannot
    //    refuse is not a criterion.
    const wantText = successText?.trim();
    const wantSelector = successSelector?.trim();
    if ((wantText || wantSelector) && !criterionWasAlreadyTrue) {
      const found = await waitForSuccessCriterion(page, wantSelector, wantText);
      if (found) return { success: true, reason: found };
      // The VERDICT is unchanged — the criterion is still authoritative and its absence is
      // still a failure. This only says something truer about WHY.
      //
      // "The success criterion never appeared" points at the criterion, so that is where
      // people look: they re-check the text, widen it, try a selector. But the same message
      // is produced when the credentials were simply wrong, and a site that rejects a login
      // without printing anything (some panels do exactly that: the form stays filled, the
      // page does not move, nothing is shown) is indistinguishable from a criterion that is
      // merely mistyped. The login form still sitting there is the difference, and asking
      // costs one DOM read on a path that has already failed.
      const stillShowingForm = await loginFormEvidence(page).catch(() => "");
      return {
        success: false,
        reason:
          `The success criterion never appeared — ${wantText ? `text "${wantText}"` : `selector "${wantSelector}"`} ` +
          `was not on the page ${Math.round(CRITERION_WAIT_MS / 1000)}s after submitting. URL: ${page.url()}` +
          (submitError ? ` The site said: "${submitError}"` : "") +
          (stillShowingForm
            ? ` The login form is still on screen (${stillShowingForm}), so the submit was rejected or ignored — ` +
              `check the credentials before the criterion.`
            : ""),
      };
    }

    const finalUrl = page.url();

    // 1. The site itself reported a failure. Captured at submit time by the watcher, which
    //    is the only place a message that lives for six seconds can be seen. This used to be
    //    read and then discarded whenever a later heuristic guessed "success" — a page
    //    saying "these credentials do not match our records" was reported as a login.
    if (submitError) {
      return { success: false, reason: `The site reported an error: "${submitError}"` };
    }

    // 2. The login form is still there — whatever the URL says, we are not logged in.
    const stillOnForm = await loginFormEvidence(page);
    if (stillOnForm) {
      return { success: false, reason: `Login did not go through — ${stillOnForm}. URL: ${finalUrl}` };
    }

    // 3. URL changed → success. Only meaningful now that the two checks above have ruled
    //    out the ways a URL can change without a session being created.
    if (normalize(finalUrl) !== normalize(targetUrl)) {
      return { success: true, reason: `Navigated to: ${finalUrl}` };
    }

    // 4. URL is the same — look for visible error messages
    const errorText = await page.evaluate(() => {
      const ERROR_SELS = [
        ".error-message", ".alert-danger", ".alert-error", ".error",
        "[class*='error' i]:not(input):not(label)",
        "[class*='invalid' i]:not(input):not(label)",
        "[role='alert']", "[aria-live='assertive']",
        "p.text-red-500", "span.text-red-500", "div.text-red-600",
      ];
      for (const sel of ERROR_SELS) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
        for (const el of els) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const text = el.textContent?.trim() ?? "";
          if (
            style.display !== "none" && style.visibility !== "hidden" &&
            rect.width > 0 && text.length > 3 && text.length < 300
          ) {
            return text;
          }
        }
      }
      return "";
    }) as string;

    if (errorText) {
      return { success: false, reason: `Login error message: "${errorText}"` };
    }

    // 5. Check for common post-login indicators before checking button visibility.
    //    Many SPAs keep the submit button in DOM briefly while updating the page.
    const hasPostLoginIndicator = await page.evaluate(() => {
      // Look for elements that typically appear only after login
      const POST_LOGIN_SELS = [
        "[class*='avatar' i]", "[class*='user-menu' i]", "[class*='profile' i]",
        "[class*='dashboard' i]", "[class*='welcome' i]", "[class*='logout' i]",
        "a[href*='logout']", "a[href*='sign-out']", "a[href*='signout']",
        "button[class*='logout' i]", "[data-user]", "[data-username]",
        "img[class*='avatar' i]", ".user-info", ".user-name", "#user-menu",
      ];
      for (const sel of POST_LOGIN_SELS) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
        for (const el of els) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0) return true;
        }
      }
      return false;
    }) as boolean;

    if (hasPostLoginIndicator) {
      return { success: true, reason: `Post-login element detected on page. URL: ${finalUrl}` };
    }

    // 6. Check if the login/submit button is still visible.
    //    Per user spec: URL same + button GONE → page advanced (SPA / 2FA) → success
    //                   URL same + button STILL VISIBLE → login didn't move the page → failure
    //    Only use the caller-supplied submit selector.  The old generic fallback
    //    (button[type='submit'], button.btn-primary, …) matched post-login page
    //    elements that had nothing to do with the login form, causing false negatives.
    if (!submitSel) {
      // No submit selector supplied. The password field is already known to be gone (rule 2),
      // which is the part that actually distinguishes a login from a page that ignored us —
      // this is a weak success, not the bare "nothing looked wrong" it used to be.
      return { success: true, reason: `The login form is gone and nothing reported an error. URL: ${finalUrl}` };
    }

    const checkLoginBtnVisible = async (): Promise<boolean> => {
      return page.evaluate((s: string) => {
        const els = Array.from(document.querySelectorAll<HTMLElement>(s));
        return els.some((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
        });
      }, submitSel as never) as Promise<boolean>;
    };

    const btnVisible = await checkLoginBtnVisible();
    if (!btnVisible) {
      // Login button gone — page advanced (SPA login, 2FA screen loading, etc.)
      return { success: true, reason: `Login button disappeared, page advanced. URL: ${finalUrl}` };
    }

    // Button still visible — give the page a bit more time then re-check
    await sleep(2500);
    const urlAfterWait = page.url();
    if (normalize(urlAfterWait) !== normalize(targetUrl)) {
      return { success: true, reason: `Navigated to: ${urlAfterWait} (after extra wait)` };
    }
    const stillVisible = await checkLoginBtnVisible();
    if (stillVisible) {
      return { success: false, reason: "Login button still visible after submission — credentials may be incorrect or login failed" };
    }
    return { success: true, reason: `Login button disappeared after extra wait. URL: ${urlAfterWait}` };
  }

  /**
   * Dismiss common cookie consent banners, GDPR overlays, and notification popups
   * that can block form fields and captcha widgets.
   */
  async function dismissCookieConsent(page: PageAdapter): Promise<void> {
    // Try CSS-based selectors first
    const CONSENT_SELECTORS = [
      "button[class*='cookie' i][class*='accept' i]",
      "button[id*='cookie' i][id*='accept' i]",
      "a[class*='cookie' i][class*='accept' i]",
      "[data-testid*='cookie-accept' i]",
      "button[class*='consent' i][class*='accept' i]",
      ".cookie-banner button", ".cookie-notice button",
      "#cookie-banner button", "#cookie-notice button",
      ".gdpr-banner button",
      // CookieYes (cky-) consent banners — common on the sites we test
      ".cky-btn-accept",
      "button.cky-btn-accept",
      "[data-cky-tag='accept-button']",
      ".cky-consent-bar button[class*='accept' i]",
    ];
    for (const sel of CONSENT_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.evaluate((e: Element) => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        }).catch(() => false) as boolean;
        if (visible) {
          await el.click();
          logger.debug({ selector: sel }, "Dismissed cookie/consent overlay");
          await sleep(300);
          return;
        }
      } catch { /* ignore */ }
    }

    // Fallback: find buttons by text content (works with both Playwright and
    // Puppeteer adapters). Match by SUBSTRING, not exact equality — the
    // known-good reference implementation just does `"Accept" in btn.text`,
    // so a button labelled "Accept cookies" / "I Accept" / "Accept all cookies"
    // is dismissed too (our old exact-equality check silently missed all of them).
    try {
      await page.evaluate(() => {
        // Distinctive substrings that are safe to match anywhere in the label.
        const contains = ["accept", "agree", "allow all", "got it", "接受", "同意", "同意并继续"];
        // Short/ambiguous labels only matched exactly (so "OK" doesn't fire on
        // "Bookmark"/"Cookie" etc.).
        const exact = ["ok", "close", "关闭"];
        const buttons = Array.from(
          document.querySelectorAll<HTMLElement>("button, a[role='button'], [role='button'], [class*='btn'], a[class*='accept' i]"),
        );
        for (const btn of buttons) {
          const raw = (btn.textContent ?? "").trim();
          const text = raw.toLowerCase();
          const style = window.getComputedStyle(btn);
          const rect = btn.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || rect.width === 0) continue;
          if (raw.length > 40) continue; // skip paragraph-length "buttons"
          const hit =
            contains.some((t) => text.includes(t) || raw.includes(t)) ||
            exact.some((t) => text === t || raw === t);
          if (hit) {
            btn.click();
            return;
          }
        }
      });
    } catch { /* ignore */ }

    // Language-agnostic fallback: if a consent overlay is STILL up (its button
    // text wasn't English/Chinese, or clicking didn't dismiss it), remove the
    // banner/overlay by its class/id — never relies on button language. Guarded
    // so we never nuke a container that actually holds the login form.
    try {
      await page.evaluate(() => {
        const sels =
          "[class*='cookie' i],[id*='cookie' i],[class*='consent' i],[id*='consent' i]," +
          "[class*='gdpr' i],[id*='gdpr' i],[aria-label*='cookie' i],.cky-consent-container,.cky-overlay,.cc-window";
        document.querySelectorAll<HTMLElement>(sels).forEach((e) => {
          const r = e.getBoundingClientRect();
          const st = window.getComputedStyle(e);
          if (r.width > 0 && r.height > 0 && st.display !== "none") {
            if (!e.querySelector("input[type='password'], input[type='email'], input[name='email' i]")) {
              e.remove();
            }
          }
        });
      });
    } catch { /* ignore */ }
  }

  // Fill an input with REAL keyboard interaction (known-good): click to focus,
  // clear, then type char-by-char. Real key events are what framework-controlled
  // inputs (React/Vue) and picky forms require to register
  // the value — a bare native-setter fill left those fields "empty" at submit
  // ("Please fill in all required fields") or made GitHub reject the login.
  // Self-healing net: if focus-stealing/overlays garble the typed value, set it
  // directly via the native setter and fire input/change.
  async function jsFillInput(page: PageAdapter, selector: string, text: string): Promise<void> {
    let clicked = true;
    // 15 s, not the 60 s default. This click only focuses a field we have ALREADY
    // located and confirmed visible, so the wait here is purely for the driver's
    // actionability checks (stable box / hit-testable / enabled) — those settle in
    // well under a second or, as measured, never. A production run spent 60 s here
    // on the username and 60 s again on the password, silently, and the 121 s that
    // cost is most of what pushed the login past its 298 s attempt budget.
    //
    // And log WHY. The exception names the check that failed ("element is not
    // stable", "<div> intercepts pointer events") and the bare `catch {}` that used
    // to be here threw that away — leaving the 60 s stall diagnosable only by
    // subtracting log timestamps. If anything legitimately needs longer than 15 s,
    // this line is what will show it.
    try {
      await page.click(selector, { timeout: 15_000 });
    } catch (err) {
      clicked = false;
      logger.warn(
        { selector, reason: (err as Error)?.message?.split("\n").slice(0, 6).join(" | ") },
        "Input was not clickable — filling it directly instead",
      );
    }
    if (clicked) {
      await page.evaluate((sel: unknown) => {
        const el = document.querySelector<HTMLInputElement>(sel as string);
        if (el) el.value = "";
      }, selector as never);
      await page.keyboard.type(text, { delay: 50 });
    }
    // Runs when the field wasn't clickable (typing skipped so stray keystrokes
    // don't land elsewhere) OR when the typed value didn't fully land.
    await page.evaluate((arg: unknown) => {
      const { sel, val } = arg as { sel: string; val: string };
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el || el.value === val) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, val); else el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { sel: selector, val: text } as never);
  }

  // Click the real submit/login control via CSS selectors (known-good). We do
  // NOT text-match login words: matching "sign in" hit "Sign in with Google" and
  // sent back4app to an OAuth redirect. We also drop the loose `[class*='login']`
  // that matched one panel's `login-nav-theme-toggle`. When no submit control is
  // found, return false so the caller presses Enter (which submits the form the
  // focused password field belongs to). As a last resort, requestSubmit() the
  // password field's own form — this fires onSubmit WITHOUT clicking any button,
  // so it can never trip a social-login button.
  /**
   * Tick the checkboxes a login form makes you tick before it will accept a submit.
   *
   * Returns the label text of everything it ticked, so the log records what was agreed to
   * rather than that something was.
   *
   * TICKS EVERY VISIBLE CHECKBOX IN THE LOGIN FORM, rather than trying to recognise the
   * agreement one. Recognising it means an ALLOWLIST of agreement words, and an allowlist
   * has to be complete to work: one unlisted language and the login simply fails. Ticking
   * everything is wrong only in ways that do not apply here — this is a LOGIN form, not a
   * registration, so the boxes on it are the terms box, "remember me", and little else.
   * The marketing blocklist below survives on the opposite asymmetry: a blocklist that
   * misses something only means one extra box gets ticked, which is the accepted default
   * anyway.
   *
   * (Measured on hub.weirdhost's login page, which is what prompted this: one checkbox,
   * no id, no name, no `required`, a submit button that is never disabled, and Korean
   * label text. Nothing structural to key on at all.)
   *
   * Two guards, neither of which is about language:
   *
   *  • VISIBLE ONLY. A hidden checkbox is a honeypot, and "ticks everything including the
   *    invisible one" is precisely the bot signature it is there to catch. Custom-styled
   *    checkboxes complicate this — they are often the real input made zero-sized with a
   *    styled span drawn over it — so a box with no rectangle of its own still counts if
   *    its label or wrapper has one. What never counts is anything under display:none /
   *    visibility:hidden, or parked off-screen.
   *
   *  • THE PASSWORD FIELD'S OWN FORM. A login page routinely carries a cookie banner and a
   *    newsletter signup with checkboxes of their own, and neither is ours to touch.
   */
  async function tickRequiredAgreements(
    page: PageAdapter,
  ): Promise<{ ticked: string[]; saw: string[] }> {
    return (await page
      .evaluate(() => {
        // Only a blocklist. See above for why there is no matching allowlist.
        const MARKETING =
          /newsletter|subscri|promo|marketing|advertis|mailing list|offers|广告|廣告|营销|營銷|订阅|訂閱|推送|마케팅|광고|수신|메일|メルマガ|広告|配信|рассылк/i;

        const boxOf = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? r : null;
        };
        const shown = (el: Element) => {
          for (let n: Element | null = el; n; n = n.parentElement) {
            const s = getComputedStyle(n as HTMLElement);
            if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
          }
          return true;
        };
        const labelEl = (el: HTMLInputElement) =>
          (el.id ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`) : null) ??
          el.closest("label") ??
          (el.parentElement as HTMLElement | null);
        const visible = (el: HTMLInputElement) => {
          if (!shown(el)) return false;
          // The input's own rectangle, or failing that its label's — a zero-sized input
          // under a drawn label is a styled checkbox, not a hidden one.
          const r = boxOf(el) ?? (labelEl(el) ? boxOf(labelEl(el)!) : null);
          if (!r) return false;
          // Parked off-screen is hidden by another name.
          return r.bottom > 0 && r.right > 0 && r.top < innerHeight + 2000 && r.left < innerWidth + 2000;
        };
        const labelOf = (el: HTMLInputElement) => {
          const t = labelEl(el)?.innerText ?? el.getAttribute("aria-label") ?? el.name ?? "";
          return t.replace(/\s+/g, " ").trim().slice(0, 160);
        };

        const pw = (document.querySelector("input[data-wa-pass='1']") ??
          document.querySelector('input[type="password"]')) as HTMLInputElement | null;
        const scope: ParentNode = pw?.form ?? document;

        const ticked: string[] = [];
        // Everything considered, with the reason it was passed over. A run that ticks
        // nothing has to say whether it found no checkbox, found a hidden one, or found a
        // marketing one — three different situations that all end in "nothing ticked".
        const saw: string[] = [];
        for (const b of Array.from(scope.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))) {
          const label = labelOf(b);
          if (b.checked) { saw.push(`already ticked: ${label}`); continue; }
          if (b.disabled) { saw.push(`disabled: ${label}`); continue; }
          if (!visible(b)) { saw.push(`hidden (honeypot?): ${label || b.name || b.id}`); continue; }
          if (MARKETING.test(label)) { saw.push(`marketing, left alone: ${label}`); continue; }
          // A REAL click. React binds onChange through the click event, and assigning
          // .checked fires nothing at all — the box would look ticked and the site would
          // still refuse. Clicking the input works even when it is visually replaced by a
          // styled span, because the input is what carries the handler; if some design put
          // the handler on the label instead, click that.
          b.click();
          if (!b.checked) labelEl(b)?.click();
          if (b.checked) ticked.push(label);
          else saw.push(`would not tick: ${label}`);
        }
        return { ticked, saw };
      })
      .catch((err) => ({ ticked: [] as string[], saw: [`probe threw: ${String(err).slice(0, 120)}`] }))) as {
      ticked: string[];
      saw: string[];
    };
  }

  async function jsClickSubmit(page: PageAdapter): Promise<boolean> {
    return (await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const firstVisibleIn = (root: ParentNode, sel: string): HTMLElement | null => {
        for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
          if (isVisible(el)) return el;
        }
        return null;
      };
      // Real submit controls preferred; class-based guesses only as fallback. We
      // never text-match login words (that clicked back4app's "Sign in with
      // Google"), and we only ever click VISIBLE controls (ct8.pl has a hidden
      // zero-size button[type=submit] that made the cf-proxy click throw
      // "element not interactable").
      const SUBMIT = "button[type='submit'], input[type='submit']";
      const CLASSY = "button.login-btn, button.btn-primary, button[class*='submit' i], button[class*='sign-in' i]";

      // Anchor on the marked login password field (set by locateLoginFields) so
      // we target the right form even when a register form is also present.
      const pw = (document.querySelector("input[data-wa-pass='1']")
        ?? document.querySelector('input[type="password"]')) as HTMLInputElement | null;
      const form = (pw?.form ?? null) as HTMLFormElement | null;

      // 1. Visible submit INSIDE the login form (preferred — avoids a sibling
      //    register/search/save button in another form).
      if (form) {
        const inForm = firstVisibleIn(form, SUBMIT) || firstVisibleIn(form, CLASSY);
        if (inForm) { inForm.click(); return true; }
      }
      // 2. Visible submit anywhere. Covers login buttons rendered OUTSIDE the
      //    <form>, or pages with no <form>. Only VISIBLE controls, so a hidden
      //    register-tab button is skipped. (Must come BEFORE requestSubmit: an
      //    SPA login button's onclick won't fire from a bare form.requestSubmit.)
      const anyBtn = firstVisibleIn(document, SUBMIT) || firstVisibleIn(document, CLASSY);
      if (anyBtn) { anyBtn.click(); return true; }
      // 3. Last resort: submit the login form programmatically.
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
        return true;
      }
      return false;
    }) as boolean);
  }

  /**
   * Locate the LOGIN form's username + password fields, scoped so we can't pick
   * fields from a sibling register/other form. Anchor on the first VISIBLE
   * password input; the username is the best-matching visible input that comes
   * BEFORE that password (login forms are always username-then-password) and
   * isn't a honeypot. This fixes pages that render both a Login
   * and a Register form — where a global `input[type='email']` match grabbed the
   * REGISTER email field and left the real Login username empty.
   *
   * Returns unique data-attribute selectors, or null if no visible password
   * field exists yet (caller falls back to the global selector search).
   */
  async function locateLoginFields(page: PageAdapter): Promise<{ userSel: string; passSel: string } | null> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const ok = await page.evaluate((pats: unknown) => {
        const userPats = pats as string[];
        const isVis = (e: Element) => {
          const el = e as HTMLElement;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const pw = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='password']")).find(isVis);
        if (!pw) return false;
        const before = (e: Element) => !!(pw.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING);
        const honeypot = /website|honeypot|confirm/i;
        const skipTypes = ["password", "hidden", "checkbox", "radio", "submit", "button", "file", "range", "color"];
        const cands = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(
          (e) =>
            isVis(e) &&
            before(e) &&
            !skipTypes.includes(e.type) &&
            !honeypot.test(e.name || "") &&
            !honeypot.test(e.id || ""),
        );
        let user: HTMLInputElement | undefined;
        for (const p of userPats) {
          user = cands.find((e) => { try { return e.matches(p); } catch { return false; } });
          if (user) break;
        }
        if (!user) user = cands[cands.length - 1]; // closest visible field before the password
        if (!user) return false;
        // Clear any stale marks, then tag this run's fields.
        document.querySelectorAll("[data-wa-user],[data-wa-pass]").forEach((e) => {
          e.removeAttribute("data-wa-user");
          e.removeAttribute("data-wa-pass");
        });
        user.setAttribute("data-wa-user", "1");
        pw.setAttribute("data-wa-pass", "1");
        return true;
      }, USERNAME_SELECTORS as never) as boolean;
      if (ok) return { userSel: "input[data-wa-user='1']", passSel: "input[data-wa-pass='1']" };
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  /**
   * What a login failure SOUNDS like, for pages whose markup gives us nothing to match.
   *
   * The class-name selectors below cover panels that name their error containers. Plenty do
   * not: a styled-components or CSS-modules theme ships hashed class names ("sc-1yg9bob-0"),
   * carries no role="alert", and renders the message as an ordinary toast — the
   * Pterodactyl/Arix panel this was found on does exactly that, so every one of our
   * selectors matched nothing and a rejected login looked like a quiet page.
   *
   * Deliberately phrase-specific rather than keyword-loose: "error" or "invalid" alone
   * appears in plenty of innocent copy, and a false failure here costs three retries.
   */
  const LOGIN_ERROR_PATTERNS = [
    String.raw`credentials?\s+(do(es)?\s+not\s+match|are\s+(incorrect|invalid)|were\s+(incorrect|invalid))`,
    String.raw`(invalid|incorrect|wrong)\s+(username|user\s?name|email|password|credentials|login|account)`,
    String.raw`(username|email|password)\s+(is\s+)?(invalid|incorrect|wrong)`,
    String.raw`(login|log\s?in|sign\s?in|authentication)\s+(has\s+)?(failed|was\s+unsuccessful|unsuccessful)`,
    String.raw`(failed|unable)\s+to\s+(log\s?in|sign\s?in|authenticate)`,
    String.raw`no\s+account\s+(was\s+)?found`,
    String.raw`too\s+many\s+(failed\s+)?(login\s+)?attempts`,
    String.raw`account\s+(has\s+been\s+)?(locked|disabled|suspended|banned)`,
    String.raw`(用户名|账号|賬號|帐号|邮箱|郵箱|密码|密碼)(或(密码|密碼))?\s*(错误|錯誤|不正确|不正確|无效|無效|有误|有誤)`,
    String.raw`(登录|登陆|登入)\s*(失败|失敗|错误|錯誤)`,
    String.raw`(验证码|驗證碼)\s*(错误|錯誤|不正确|不正確|已过期|已過期)`,
    String.raw`(账号|帐号|賬號|账户|帳戶)\s*(已)?\s*(被)?\s*(锁定|鎖定|禁用|封禁|停用)`,
  ];

  // Read a visible login error/alert message. Called RIGHT AFTER submit and
  // BEFORE dismissPopups — otherwise the popup cleanup clicks the alert's close
  // button (one panel's `auth-form-alert`) and erases the real reason, leaving
  // only a generic "login button still visible".
  async function readLoginError(page: PageAdapter, scanText = true): Promise<string> {
    try {
      return (await page.evaluate((arg: unknown) => {
        const { pats, scanText: scan } = arg as { pats: string[]; scanText: boolean };
        const vis = (el: HTMLElement): boolean => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return (
            r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" &&
            parseFloat(s.opacity || "1") > 0.05
          );
        };
        const sels = [
          ".auth-form-alert", "[role='alert']", ".alert-danger", ".alert-error",
          "[class*='error-message' i]", "[class*='login-error' i]", "[class*='form-error' i]",
          ".invalid-feedback", "[class*='alert' i]", "[class*='invalid' i]",
        ];
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
            if (!vis(el)) continue;
            const t = (el.textContent || "").trim();
            if (t && t.length < 300) return t;
          }
        }
        // Nothing named itself an error — go by what the page SAYS instead. Only the node
        // that owns the text (few children), so the match is a message and not the whole
        // document that happens to contain one.
        if (!scan) return "";
        const res = pats.map((p) => new RegExp(p, "i"));
        const cands = document.querySelectorAll<HTMLElement>("div,span,p,li,strong,small,label,h1,h2,h3,h4");
        const limit = Math.min(cands.length, 4000);
        for (let i = 0; i < limit; i++) {
          const el = cands[i];
          if (el.children.length > 3) continue;
          const t = (el.textContent || "").trim();
          if (t.length < 4 || t.length > 200) continue;
          if (!res.some((r) => r.test(t))) continue;
          if (!vis(el)) continue;
          return t;
        }
        return "";
      }, { pats: LOGIN_ERROR_PATTERNS, scanText } as never)) as string;
    } catch { return ""; }
  }

  /**
   * Submit the 2FA form — the one the code was typed into, not whichever form is first.
   *
   * This used to click `page.$("button[type='submit'], input[type='submit']")`, a document-
   * wide query that returns the first match in DOCUMENT order. On a 2FA screen the login
   * form is often still in the DOM (an SPA keeps it, or it is merely hidden), so the first
   * submit button is the LOGIN button — and clicking it re-submits the credentials form
   * whose CSRF token the first submit already consumed. The site answers "CSRF token
   * mismatch" while the real verification code sits there unsent, which is exactly the
   * combination reported: the login reached the 2FA screen AND an error appeared.
   *
   * jsClickSubmit already anchors on the password field's form for the same reason; this is
   * the same trick for the OTP field. Falling back to Enter is safe: focus is in that field,
   * so the browser submits the form it belongs to and no other.
   */
  async function jsSubmitOtpForm(page: PageAdapter): Promise<boolean> {
    try {
      return (await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = getComputedStyle(el as HTMLElement);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const otp = document.querySelector("input[data-wa-otp='1']") as HTMLInputElement | null;
        const form = (otp?.form ?? null) as HTMLFormElement | null;
        if (!form) return false;
        for (const el of Array.from(form.querySelectorAll<HTMLElement>("button[type='submit'], input[type='submit']"))) {
          if (isVisible(el)) { el.click(); return true; }
        }
        // No button inside it — submit the form itself rather than reaching outside it.
        if (typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
        return false;
      })) as boolean;
    } catch {
      return false;
    }
  }

  /** Is a two-factor code field on screen right now? */
  async function otpFieldVisible(page: PageAdapter, selectors: string): Promise<boolean> {
    try {
      const el = await page.$(selectors);
      if (!el) return false;
      return (await el.evaluate((e: Element) => {
        const s = window.getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
      })) as boolean;
    } catch {
      return false;
    }
  }

  /**
 * Is a reCAPTCHA challenge popup actually open?
 *
 * Its iframe exists on every page that loads reCAPTCHA, collapsed and idle, so this
 * measures rather than counts: an open challenge is around 400x580.
 */
async function waitForRecaptchaPopup(page: PageAdapter, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const open = (await page
      .evaluate(() => {
        const f = document.querySelector<HTMLIFrameElement>(
          "iframe[src*='api2/bframe'], iframe[src*='enterprise/bframe']",
        );
        if (!f) return false;
        const cs = getComputedStyle(f);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        const r = f.getBoundingClientRect();
        return r.width >= 300 && r.height >= 300;
      })
      .catch(() => false)) as boolean;
    if (open) return true;
    await sleep(500);
  }
  return false;
}

export async function formLogin(
    page: PageAdapter,
    targetUrl: string,
    credentials: FormCredentials,
    solver: CaptchaSolver | null,
    successSelector?: string,
    totpSecret?: string,
    successText?: string,
  ): Promise<LoginResult> {
    // Track dialog messages BEFORE attaching the auto-dismiss popup handler,
    // so we can capture the message content for captcha error detection.
    let lastDialogMessage = "";
    page.on("dialog", ((dialog: { message(): string }) => {
      lastDialogMessage = dialog.message();
    }) as never);

    attachPopupHandler(page);

    try {
      logger.info({ targetUrl }, "Starting form login flow");
      // Tolerant: a self-refreshing CF interstitial can blow the load budget while being
      // perfectly present and clickable. clearCloudflareInterstitial runs right below.
      await gotoTolerant(page, targetUrl, 20000);

      // ── 0a. Clear a full-page Cloudflare interstitial FIRST ───────────────
      // Several of the panels we test against
      // serve the login page behind a full-page CF challenge ("Just a moment…").
      // The username/password fields do not exist until the challenge clears, so
      // we must pass it *before* trying to locate the form — otherwise findSelector
      // times out and login fails without the CF bypass ever running.
      // (The SeleniumBase/cf-proxy backend clears this natively via
      // uc_open_with_reconnect on every goto; this brings the CDP/local backends
      // to parity.)
      try {
        const cleared = await clearCloudflareInterstitial(page, { url: targetUrl });
        if (!cleared) {
          // Is the challenge STILL up? If so, stop here instead of hunting for a form
          // that cannot exist yet. This also stops the caller from burning its
          // remaining login attempts: each one would re-run the full CF bypass budget
          // (~90s) against the same wall, which is how a doomed login stretched into
          // 15 minutes. captchaBlocked marks it as "needs attention", not a retry.
          const stillBlocked = (await page
            .evaluate(() => {
              // A visible login form means the page DID load — an embedded Turnstile in
              // that form is solved before submit, it is not a full-page
              // block. Only a page that is ONLY the challenge (no form) is genuinely
              // still blocking. Keying off the widget input alone treated a loaded
              // login page as blocked and returned needs-attention without ever filling
              // the form.
              const hasForm = !!document.querySelector(
                "input[type='password'], input[name='email'], input[name='username']",
              );
              if (hasForm) return false;
              // window._cf_chl_opt first: the current challenge platform puts the widget,
              // its response input and its iframe inside a CLOSED shadow root, so none of
              // the selectors below exist on a page that is nothing BUT a challenge. Going
              // by them alone, we answered "not blocked" and then reported the real problem
              // as "could not find username/email input field on the page".
              try {
                if ((window as unknown as { _cf_chl_opt?: unknown })._cf_chl_opt) return true;
              } catch { /* fall through to the markup probes */ }
              return !!document.querySelector(
                'input[id^="cf-chl-widget-"][id$="_response"], #challenge-stage, ' +
                  '#challenge-running, .cf-browser-verification',
              );
            })
            .catch(() => false)) as boolean;
          if (stillBlocked) {
            // Report WHAT the widget shows, not just "it failed". The three states need
            // three different fixes: "Verify you are human" = our click never landed,
            // "Verifying…" = it is still working and we ran out of budget, "Verification
            // failed" = the click landed but was judged a bot (IP/fingerprint).
            const widget = await describeTurnstileState(page);
            return {
              success: false,
              captchaBlocked: true,
              message:
                "Cloudflare challenge is still up after the bypass budget — the login page never loaded. " +
                `Widget state: "${widget}".`,
            };
          }
          logger.warn({ targetUrl }, "Cloudflare interstitial not confirmed cleared before login — continuing anyway");
        }
      } catch (cfErr) {
        logger.warn({ targetUrl, cfErr }, "Cloudflare interstitial pre-clear threw — continuing");
      }

      // ── 0b. Wait for the post-challenge redirect to land ───────────────────
      // Passing the interstitial does NOT mean the login form is there: sites like
      // gate /auth/login behind a challenge page that, once
      // passed, REDIRECTS to the real login page. We used to fall straight through
      // (a 500ms sleep) and hunt for inputs while the challenge page was still up,
      // so login failed with "could not find username field" even though the
      // challenge had been cleared. Wait for a login form (or another challenge —
      // some of these sites then embed a SECOND captcha in the form itself) to
      // actually materialise before moving on.
      {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const state = (await page
            .evaluate(() => {
              const vis = (el: Element | null): boolean => {
                if (!el) return false;
                const r = (el as HTMLElement).getBoundingClientRect();
                const s = window.getComputedStyle(el as HTMLElement);
                return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
              };
              const hasForm =
                vis(document.querySelector("input[type='password']")) ||
                vis(document.querySelector("input[type='email']")) ||
                vis(document.querySelector("input[name*='user' i], input[name*='email' i]"));
              const onChallenge = !!document.querySelector(
                'input[id^="cf-chl-widget-"][id$="_response"], script[src*="challenges.cloudflare.com"]',
              );
              return { hasForm, onChallenge };
            })
            .catch(() => ({ hasForm: false, onChallenge: false }))) as {
            hasForm: boolean;
            onChallenge: boolean;
          };
          // The form is up — done, even if a second (embedded) captcha rides along:
          // the captcha handling further down deals with that one.
          if (state.hasForm) break;
          await sleep(1000);
        }
      }

      // ── 0. Dismiss cookie consent banners & common popups ─────────────────
      // These overlays can block captcha widgets and form fields. Dismiss them
      // early so subsequent interactions land on the correct elements.
      await dismissCookieConsent(page);
      await sleep(500);

      // ── 1. Fill form fields FIRST (before captcha) ────────────────────────
      // Many sites (especially those using GeeTest/click-to-verify captchas)
      // expect form fields to be populated before the captcha is interacted with.
      // Filling first also avoids wasting time if fields can't be found.
      // Prefer form-scoped field detection (anchors on the visible password so a
      // sibling register form can't steal the username). Fall back to the global
      // selector search when there's no visible password field (e.g. two-step
      // "username first" logins).
      const scoped = await locateLoginFields(page);
      const usernameSel = scoped?.userSel ?? (await findSelector(page, USERNAME_SELECTORS));
      if (!usernameSel) {
        // No login form. The interesting case is that there is nothing to log into BECAUSE
        // WE ALREADY ARE — which is exactly what a retry looks like after a login that
        // worked: the panel bounces /auth/login to the dashboard, no username field exists,
        // and the run reports "Could not find username/email input field" about a perfectly
        // good session. Ask the caller's own criterion before calling this a failure.
        const wantText = successText?.trim();
        const wantSelector = successSelector?.trim();
        if (wantText || wantSelector) {
          const found = await waitForSuccessCriterion(page, wantSelector, wantText, 8000);
          if (found) {
            logger.info({ targetUrl, url: page.url() }, "No login form — already signed in");
            return { success: true, captchaBlocked: false, message: `Already signed in. ${found}` };
          }
        }

        // No criterion configured, or it did not match — ask the page itself.
        //
        // Requiring a success text to notice an existing session was a regression I put here:
        // the check only ran when one was set, so a task without one reported "Could not find
        // username/email input field" about a session that was working, from a URL that was
        // plainly not a login page. detectLoginState answers this without configuration, and
        // only its POSITIVE verdict counts — a visible sign-out or account affordance. An
        // "unknown" page is still a failure, because guessing success from the absence of a
        // login form is how a run ends up reporting a login that never happened.
        const { verdict, evidence } = await detectLoginState(page);
        if (verdict === "logged_in") {
          logger.info({ targetUrl, url: page.url(), evidence }, "No login form — already signed in");
          return { success: true, captchaBlocked: false, message: `Already signed in (${evidence}). URL: ${page.url()}` };
        }

        // Second signal, for panels whose markup carries no word detectLoginState knows.
        //
        // We navigated to the login URL and were NOT shown a login form — no username field,
        // no password field, no "sign in with". A site that wanted us to log in would have
        // put one in front of us; being let through to a real page instead is what an
        // existing session looks like. Reported from betadash.lunes.host, which leaves an
        // authenticated request on /servers/<id> and bounces an anonymous one to /login.
        //
        // Guarded against the way this could lie: a page that failed to load has no login
        // form either. So the URL must not itself look like a login page, and there has to
        // be real content on it.
        if (verdict === "unknown") {
          const here = page.url();
          const looksLikeLoginUrl = /\/(login|signin|sign-in|auth)(\/|\?|#|$)/i.test(here);
          const bodyLen = (await page
            .evaluate(() => (document.body?.innerText ?? "").trim().length)
            .catch(() => 0)) as number;
          if (!looksLikeLoginUrl && bodyLen > 200) {
            logger.info(
              { targetUrl, url: here, bodyLen },
              "No login form and no login page — treating this as an existing session",
            );
            return {
              success: true,
              captchaBlocked: false,
              message: `Already signed in — the site served ${here} without asking to log in.`,
            };
          }
        }

        return {
          success: false,
          captchaBlocked: false,
          message:
            `Could not find username/email input field on the page (${evidence}). URL: ${page.url()}` +
            (wantText || wantSelector
              ? " — and the success criterion is not there either, so this is neither a login page nor a signed-in one."
              : ""),
        };
      }
      await jsFillInput(page, usernameSel, credentials.username);

      const passwordSel = scoped?.passSel ?? (await findSelector(page, PASSWORD_SELECTORS));
      if (!passwordSel) {
        return { success: false, captchaBlocked: false, message: "Could not find password input field on the page" };
      }
      await jsFillInput(page, passwordSel, credentials.password);

      // ── 2. Handle captcha AFTER filling fields, BEFORE submit ─────────────
      const captchaResult = await detectAndHandleCaptcha(page, solver);
      if (captchaResult.detected && !captchaResult.solved) {
        if (captchaResult.needsAttention) {
          return { success: false, captchaBlocked: true, message: captchaResult.message };
        }
        logger.warn("Captcha detected but not solved — attempting login anyway");
      }

      // Does the success criterion already hold on the LOGIN page? Asked here, while we are
      // still definitely logged out, because the answer decides whether it can be used as
      // proof afterwards. A criterion that was true before we submitted proves nothing —
      // "Heaven Cloud" in the header is on the login page too — and now that the criterion
      // is authoritative, believing it would turn every failed attempt into a success.
      const criterionWasAlreadyTrue = !!(
        (successText?.trim() || successSelector?.trim()) &&
        (await waitForSuccessCriterion(page, successSelector?.trim(), successText?.trim(), 0))
      );
      if (criterionWasAlreadyTrue) {
        logger.warn(
          { targetUrl, successText, successSelector },
          "The login success criterion is already satisfied on the login page — it cannot prove a login, " +
            "so the outcome will be judged without it. Pick something that only exists once signed in.",
        );
      }

      // ── 3. Tick whatever the form makes you agree to, then submit ─────────
      //
      // Logged either way, and with what it SAW. Reporting only successes made "the build
      // does not have this yet" and "it ran and found nothing to tick" produce identical
      // logs — silence — which is the one thing a log must never do for two states that
      // need different fixes.
      const agreed = await tickRequiredAgreements(page);
      logger.info(
        agreed.ticked.length ? { agreed: agreed.ticked } : { saw: agreed.saw },
        agreed.ticked.length
          ? "Ticked the login form's agreement checkbox(es) before submitting"
          : "No checkbox to tick before submitting",
      );

      if (!(await jsClickSubmit(page))) {
        await page.keyboard.press("Enter");
      }

      // SOLVE THE CHALLENGE THAT SUBMITTING BRINGS UP, if one comes.
      //
      // An invisible reCAPTCHA scores the visitor when the form is submitted and only then
      // decides whether to ask anything. Nothing may touch it BEFORE that — going looking
      // for a checkbox to tick is what used to summon a challenge onto a page that had
      // none — but once the popup is genuinely on screen it is the entire reason the login
      // is stuck, and the audio solver exists for exactly this.
      //
      // "Genuinely on screen" is measured, not counted: reCAPTCHA creates its challenge
      // iframe up front on every page and leaves it collapsed, so its presence proves
      // nothing and its size proves it. Waited for, because the popup arrives a moment
      // after the click.
      if (await waitForRecaptchaPopup(page, 8000)) {
        logger.info("A reCAPTCHA challenge opened after submitting — solving it");
        const solved = await solveRecaptchaAudio(page);
        logger.info(
          { solved: solved.solved, blocked: solved.blocked, message: solved.message },
          "Post-submit reCAPTCHA solve finished",
        );
        if (solved.solved) {
          // The site's own callback usually submits once the token lands; if the form is
          // still there, press again rather than leave a solved challenge unspent.
          await sleep(1500);
          if (await loginFormEvidence(page)) {
            if (!(await jsClickSubmit(page))) await page.keyboard.press("Enter");
          }
        }
      }

      // Watch from the moment of submit until the login resolves, instead of settling for a
      // fixed few seconds and then looking once — a message that appears late, or one that
      // removes itself after six seconds, is invisible to a single read.
      //
      // DON'T run dismissPopups here: after submit it was clicking the site's own
      // login-result alert (one panel's auth-form-alert), which erased the real reason and
      // could reset the form / Turnstile. Overlays that block the FORM/captcha are already
      // cleared before fill (dismissCookieConsent). Post-submit, we only observe.
      let submitError = (await awaitLoginResolution(page)).error;
      if (submitError) logger.warn({ submitError }, "Login page shows an error message after submit");

      // Check if a dialog popped up indicating captcha was required but not solved.
      // Chinese sites commonly show alerts like "请先完成验证码验证".
      if (lastDialogMessage) {
        const captchaDialogPatterns = [
          /验证码/i, /captcha/i, /verify/i, /验证/i, /人机/i,
          /robot/i, /human/i, /challenge/i,
        ];
        const isCaptchaDialog = captchaDialogPatterns.some((p) => p.test(lastDialogMessage));
        if (isCaptchaDialog) {
          logger.warn({ dialogMessage: lastDialogMessage }, "Form submission blocked by captcha dialog — retrying captcha");
          // Wait a moment for any overlay to clear, then retry captcha
          await sleep(1500);
          const retryResult = await detectAndHandleCaptcha(page, solver);
          if (retryResult.detected && !retryResult.solved && retryResult.needsAttention) {
            return { success: false, captchaBlocked: true, message: `Captcha dialog: "${lastDialogMessage}". ${retryResult.message}` };
          }
          // Re-submit after captcha retry
          if (!(await jsClickSubmit(page))) {
            await page.keyboard.press("Enter");
          }
          submitError = (await awaitLoginResolution(page)).error || submitError;
          await dismissPopups(page);
        }
      }


      // ── TOTP / 2FA auto-fill ──────────────────────────────────────────────
      // If a 2FA OTP input appeared after form submit, generate and fill the code.
      const effectiveTotpSecret = totpSecret ?? credentials.totpSecret;
      const otpSelectors = [
        "input[autocomplete='one-time-code']",
        "input[name='otp']", "input[name='totp']",
        "input[name='code']", "input[name='token']",
        "input[id='code']",
        "input[inputmode='numeric'][maxlength='6']",
        "input[inputmode='numeric'][maxlength='8']",
        "input[placeholder*='code' i]", "input[placeholder*='2fa' i]",
      ].join(", ");
      if (!effectiveTotpSecret) {
        // Say so, instead of skipping in silence. Landing on a two-factor prompt with no
        // secret configured is the single most likely reason a login "stops for no reason",
        // and it used to produce no log line at all — the run failed later, on whatever
        // generic check came next, describing a symptom instead of this.
        if (await otpFieldVisible(page, otpSelectors)) {
          logger.warn(
            { targetUrl, url: page.url() },
            "Stopped at a two-factor prompt and no TOTP secret is configured for this login — nothing will be filled",
          );
        }
      }
      if (effectiveTotpSecret) {
        try {
          // WAIT for it, don't glance once.
          //
          // awaitLoginResolution returns the moment the login form goes away, which is before
          // the 2FA screen exists: this panel lazy-loads the route's chunk, so the code field
          // mounts a beat later. A single query lands in that gap, finds nothing, and the
          // whole block is skipped without a word — which is what "the 2FA page is up and
          // nothing was typed" looks like from the outside.
          const otpDeadline = Date.now() + 10_000;
          let otpVisible = false;
          while (Date.now() < otpDeadline) {
            if (await otpFieldVisible(page, otpSelectors)) { otpVisible = true; break; }
            await sleep(400);
          }
          if (!otpVisible) {
            // Our selector list did not match. Say what IS on the page so the next run names
            // the field instead of leaving us to guess at it.
            const fields = (await page
              .evaluate(() =>
                Array.from(document.querySelectorAll("input"))
                  .filter((i) => {
                    const r = i.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                  })
                  .slice(0, 8)
                  .map((i) => ({
                    type: i.type, name: i.name, id: i.id,
                    ph: i.placeholder, ac: i.autocomplete, ml: i.maxLength,
                  })),
              )
              .catch(() => [])) as unknown[];
            logger.warn(
              { targetUrl, url: page.url(), visibleInputs: fields },
              "A TOTP secret is configured but no 2FA code field matched our selectors — these are the fields that ARE on the page",
            );
          }
          if (otpVisible) {
              logger.info({ targetUrl }, "2FA / OTP field detected — auto-filling TOTP code");
              const code = generateTOTP(effectiveTotpSecret);
              await page.click(otpSelectors);
              await page.evaluate((sel: unknown) => {
                const el = document.querySelector<HTMLInputElement>(sel as string);
                // Mark the field we are actually typing into, so the submit below can find
                // the form it belongs to rather than guessing at document level.
                if (el) { el.value = ""; el.setAttribute("data-wa-otp", "1"); }
              }, otpSelectors as never);
              await page.keyboard.type(code, { delay: 80 });
              await sleep(500);
              if (!(await jsSubmitOtpForm(page))) await page.keyboard.press("Enter");
              await waitForSettle(page, 12000);
              // REPLACE, never merge: the message from the credentials step ("a verification
              // code is required") describes a screen we have since passed, and an error is
              // now decisive — carrying it forward would fail a 2FA login that worked.
              submitError = await readLoginError(page);
              await dismissPopups(page);
          }
        } catch (otpErr) {
          // Never silent. A throw here means the code was not filled, and the run then fails
          // on some later check that has nothing to do with 2FA.
          logger.warn({ targetUrl, otpErr }, "2FA handling threw — the code was not filled");
        }
      }

      // Did we end up sitting on the two-factor screen? Asked once, here, so the verdict
      // below can name that instead of reporting whichever generic check failed first.
      const stuckOnOtp = await otpFieldVisible(page, otpSelectors);
      if (stuckOnOtp) {
        return {
          success: false,
          captchaBlocked: false,
          message: effectiveTotpSecret
            ? `Login reached the two-factor prompt and the generated code did not clear it — the secret may be wrong, or the code was rejected. URL: ${page.url()}` +
              (submitError ? ` The site said: "${submitError}"` : "")
            : `Login reached a two-factor prompt, and this login has no TOTP secret configured — fill in "TOTP 密钥" on the login step (or on the saved credential) so the code can be generated. URL: ${page.url()}`,
        };
      }

      // Precise submit selector for the "is the login button still visible?"
      // success check — deliberately WITHOUT the loose `[class*='login']` that
      // matched a panel's theme-toggle-btn (which would keep it "visible" and
      // report a false failure).
      const detectSubmitSel =
        "button[type='submit'], input[type='submit'], button.login-btn, " +
        "button[class*='submit' i], button[class*='sign-in' i]";
      const outcome = await detectLoginOutcome(
        page, targetUrl, successSelector, detectSubmitSel, successText, submitError, criterionWasAlreadyTrue,
      );
      logger.info(
        {
          url: page.url(),
          success: outcome.success,
          reason: outcome.reason,
          submitError: submitError || undefined,
          criterionWasAlreadyTrue: criterionWasAlreadyTrue || undefined,
        },
        "Form login outcome",
      );

      return {
        success: outcome.success,
        captchaBlocked: false,
        message: outcome.success
          ? `Successfully logged in. ${outcome.reason}`
          : `Login failed: ${outcome.reason}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Form login error");
      return { success: false, captchaBlocked: false, message: `Form login error: ${message}` };
    }
  }
 