import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { attachPopupHandler, dismissPopups } from "./popup-handler";
import { verifyOAuthLanding, detectLoginState, clickFirstMatching, clickButtonByText, closeBlockingDialog, gotoTolerant, PhaseTimer } from "./login-verify";
import { waitForSuccessCriterion } from "./success-text";
import { clearCloudflareInterstitial } from "./cloudflare-bypass";
import { generateTotpCode } from "../lib/totp";
import { detectAndHandleCaptcha } from "./captcha";
import type { CaptchaSolver } from "./captcha-solver";
import type { LoginResult } from "./form-login";

/**
 * Put the caret in a field without depending on the pointer.
 *
 * `page.click()` here only ever existed to focus the input before typing, but it drags in
 * Playwright's full actionability contract: the element must be hittable at its centre for
 * the whole action. Google routinely covers the form for a moment (a scrim while the
 * account chooser settles, a re-render mid-navigation), and the click then retries until
 * the adapter's DEFAULT 60 s timeout and fails the whole login — with the log saying the
 * element was found, visible, enabled, stable and scrolled into view, which reads like a
 * contradiction until you notice it never says the click landed.
 *
 * So: try the real click briefly, then fall back to focusing the element directly. Typing
 * goes to the focused element either way, and nothing about the human-shaped typing
 * changes.
 */
async function focusField(page: PageAdapter, selector: string, clickMs = 8000): Promise<void> {
  const clicked = await Promise.race([
    page.click(selector).then(() => true, () => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), clickMs)),
  ]);
  if (clicked) return;
  logger.debug({ selector, clickMs }, "Click did not land in time — focusing the field directly");
  await page
    .evaluate((sel: unknown) => {
      document.querySelector<HTMLElement>(sel as string)?.focus();
    }, selector as never)
    .catch(() => {});
}

export interface GoogleCredentials {
  username: string;
  password: string;
  totpSecret?: string;
}

const GOOGLE_BUTTON_SELECTORS = [
  "a[href*='accounts.google.com']",
  "button[data-provider='google']",
  "[class*='google' i] button",
  "[class*='google' i] a",
  "a[class*='google' i]",
  "button[class*='google' i]",
  "div[class*='google' i][role='button']",
  "[data-authuser]",
];

const GOOGLE_BUTTON_TEXT_PATTERNS = [
  "sign in with google",
  "login with google",
  "continue with google",
  "connect with google",
  "google login",
  "google sign in",
  "sign up with google",
];

/**
 * Reveal a Google Sign-In button the page renders and then hides, and say where it is.
 *
 * This shape is common. The page renders
 * Google's real button into a container it keeps at `display:none`, shows its OWN styled
 * button instead, and forwards the click:
 *
 *     const el = document.querySelector('#g_id_onload_login iframe, … div[role=button]');
 *     if (el) { el.click(); return; }        // ← the whole flow dies here
 *     google.accounts.id.prompt(…)           // ← never reached
 *
 * `el.click()` on a CROSS-ORIGIN iframe does nothing: the click event goes to the iframe
 * ELEMENT in the parent document, and Google's button lives inside the frame, which only
 * honours real input of its own. So the site's button is clicked, its handler runs, and
 * nothing happens — which is exactly what the log showed: the button found, clicked, and
 * the URL never moving for 50 seconds.
 *
 * Making the container visible and clicking INSIDE the frame is the only way through, and
 * it is the same thing the Turnstile path already does for a clipped widget.
 */
const REVEAL_GSI_BUTTON_JS = `(function () {
  var f = document.querySelector("iframe[src*='accounts.google.com/gsi/button']");
  if (!f) return null;
  // Un-hide the frame and every ancestor that is hiding it. Nothing is moved or resized
  // beyond what it takes to be clickable.
  var el = f;
  for (var i = 0; i < 20 && el; i++) {
    var s = window.getComputedStyle(el);
    if (s.display === 'none') el.style.display = 'block';
    if (s.visibility === 'hidden') el.style.visibility = 'visible';
    if (parseFloat(s.opacity || '1') < 0.1) el.style.opacity = '1';
    if (s.overflow === 'hidden') el.style.overflow = 'visible';
    el = el.parentElement;
  }
  var r = f.getBoundingClientRect();
  if (r.width < 40 || r.height < 20) {
    f.style.width = '240px'; f.style.height = '44px';
    r = f.getBoundingClientRect();
  }
  f.scrollIntoView({ block: 'center', inline: 'center' });
  r = f.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
})()`;

async function clickHiddenGoogleButton(page: PageAdapter): Promise<boolean> {
  type Rect = { x: number; y: number; w: number; h: number };
  let rect: Rect | null = null;
  try {
    rect = (await page.evaluate(REVEAL_GSI_BUTTON_JS as unknown as string)) as Rect | null;
  } catch (err) {
    logger.debug({ err }, "Could not reveal the Google button frame");
    return false;
  }
  if (!rect) return false;

  const x = rect.x + rect.w / 2;
  const y = rect.y + rect.h / 2;
  logger.info({ rect }, "Google's own button was hidden — revealed it and clicking inside the frame");

  // The real X pointer when the backend has one, for the same reason the Turnstile path
  // prefers it: a cross-origin frame only counts input it receives itself.
  const osClick = (page as unknown as { osClick?: (x: number, y: number) => Promise<boolean> }).osClick;
  if (osClick && (await osClick(x, y))) {
    logger.info("Clicked Google's button with the real X pointer");
    return true;
  }
  try {
    await page.mouse.click(x, y);
    logger.info("Clicked Google's button with synthesised input");
    return true;
  } catch (err) {
    logger.debug({ err }, "Both click paths failed on the Google button frame");
    return false;
  }
}

async function clickGoogleButton(page: PageAdapter): Promise<boolean> {
  for (const sel of GOOGLE_BUTTON_SELECTORS) {
    const el = await page.$(sel);
    if (el) {
      const visible = await el.evaluate((e: Element) => {
        const style = window.getComputedStyle(e);
        const rect = e.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
      });
      if (visible) {
        logger.info({ selector: sel }, "Found Google OAuth button by selector");
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
          el.click(),
        ]);
        return true;
      }
    }
  }

  const found = await page.evaluate((patterns: unknown) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button'], div[tabindex]"));
    for (const el of els) {
      const text = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase().trim();
      if ((patterns as string[]).some((p) => text.includes(p))) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0) {
          el.click();
          return el.textContent?.trim() ?? "Google button";
        }
      }
    }
    return null;
  }, GOOGLE_BUTTON_TEXT_PATTERNS as never) as string | null;

  if (found) {
    logger.info({ text: found }, "Found Google OAuth button by text");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    return true;
  }

  return false;
}

// Google has shipped this field as type=tel, type=text, with and without name="totpPin",
// and with an inputmode/autocomplete hint — the exact combination varies by flow and
// locale. Matching too narrowly means landing on the code page and doing nothing, which is
// indistinguishable from "the login just failed".
const TOTP_INPUT_SEL =
  "input[name='totpPin'], input#totpPin, input[autocomplete='one-time-code'], " +
  "input[type='tel'], input[inputmode='numeric'], input[maxlength='6'], " +
  "input[aria-label*='code' i], input[aria-label*='驗證碼'], input[aria-label*='验证码']";

/** Is the code field on screen? Waits briefly — it renders just after the navigation. */
async function findTotpInput(page: PageAdapter, waitMs = 6000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await page.$(TOTP_INPUT_SEL)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Get through Google's second-factor step, switching challenge type when necessary.
 *
 * Returns a LoginResult only to ABORT (a factor we cannot satisfy); null means "carry on",
 * either because there was no challenge or because a code was submitted.
 */
async function resolveSecondFactor(page: PageAdapter, totpSecret?: string): Promise<LoginResult | null> {
  const deadline = Date.now() + 90_000;

  for (let round = 0; round < 4 && Date.now() < deadline; round++) {
    const url = page.url();
    if (!url.includes("accounts.google.com")) return null; // already through

    // On the code page Google renders the field a beat after the navigation, so probing
    // once loses the race and looks like "no code field here".
    const onTotpPage = /\/challenge\/totp/.test(url);
    const hasTotpInput = await findTotpInput(page, onTotpPage ? 8000 : 500);
    logger.info({ round, url, hasTotpInput }, "Google 2FA - round");

    if (hasTotpInput) {
      if (!totpSecret) {
        return {
          success: false,
          captchaBlocked: false,
          message:
            "Google is asking for a 2FA code but this credential has no TOTP secret. " +
            "Add the authenticator secret to the saved credential.",
        };
      }
      // NOT otplib: its base32 decoder rejects the spaces Google puts in the secret it
      // shows you ("abcd efgh ijkl mnop"), which threw
      // `Invalid Base32 string: Unknown letter: " "` and read as a plain login failure.
      // generateTotpCode normalises first, so a secret stored with spaces still works.
      const totp = generateTotpCode(totpSecret);
      logger.info({ round }, "Google 2FA - entering an authenticator code");
      await focusField(page, TOTP_INPUT_SEL);
      // Clear first: a rejected code can be left in the field, and typing after it
      // produces a 12-digit string that is refused for a reason nothing reports.
      await page
        .evaluate((sel: unknown) => {
          const el = document.querySelector<HTMLInputElement>(sel as string);
          if (el) el.value = "";
        }, TOTP_INPUT_SEL as never)
        .catch(() => {});
      await page.keyboard.type(totp, { delay: 80 });
      await new Promise((r) => setTimeout(r, 250));
      // Submit through the page's own button when it exists — Enter alone does not
      // always submit this form, and a code typed but never submitted is exactly the
      // "it reached the code page and then failed" shape being reported.
      await pressNext(page, "#totpNext", 30000);
      await new Promise((r) => setTimeout(r, 1500));

      // Did Google reject it? Say so — a bad secret and a clock-skewed code both look
      // like a generic login failure otherwise.
      const codeError = (await page
        .evaluate(() => {
          const el = document.querySelector(".o6cuMc, .dEOOab, [jsname='B34EJ'], [aria-live='assertive']");
          return (el?.textContent ?? "").trim().slice(0, 160);
        })
        .catch(() => "")) as string;
      if (codeError && /wrong|invalid|incorrect|錯誤|错误|无效|無效/i.test(codeError)) {
        return {
          success: false,
          captchaBlocked: false,
          message:
            `Google rejected the authenticator code ("${codeError}"). The stored TOTP secret is ` +
            "probably wrong, or this machine's clock has drifted.",
        };
      }
      continue; // re-evaluate: accepted, or yet another challenge
    }

    if (!/\/challenge\//.test(url)) return null; // not a challenge page - let the caller judge

    // A challenge we cannot answer directly. Without a TOTP there is nothing to switch TO.
    if (!totpSecret) {
      return {
        success: false,
        captchaBlocked: false,
        message: describeChallenge(url, "and this credential has no TOTP secret to fall back on"),
      };
    }

    logger.info({ url }, "Google presented a non-code challenge - switching to the authenticator app");
    const switched = await switchToAuthenticatorChallenge(page);
    if (!switched) {
      return {
        success: false,
        captchaBlocked: false,
        message: describeChallenge(url, "and no authenticator-app option was offered as an alternative"),
      };
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  return null;
}

/** Name the challenge from its URL, so a failure says what Google actually wanted. */
function describeChallenge(url: string, suffix: string): string {
  const kind = /\/challenge\/(sk|ipp|iap|totp|dp|az|kpp|pwd|selection)/.exec(url)?.[1] ?? "";
  const human: Record<string, string> = {
    sk: "a security key (WebAuthn)",
    kpp: "a passkey",
    ipp: "a code sent to your phone",
    iap: "a code sent by SMS",
    dp: "a tap on the Google prompt on your phone",
    az: "a tap on the Google prompt on your phone",
    pwd: "your password again",
    totp: "an authenticator code",
    selection: "you to pick a verification method",
  };
  return `Google is asking for ${human[kind] ?? "an additional verification step"} ${suffix}. Page: ${url}`;
}

/**
 * From a challenge page, click "Try another way" and choose the authenticator-app option.
 *
 * The picker's entries carry data-challengetype, which is language-independent - 6 is the
 * authenticator app. Text matching is only the fallback, and it has to cover the locale
 * Google picked from the exit IP (this account renders in Traditional Chinese), not just
 * English.
 */
async function switchToAuthenticatorChallenge(page: PageAdapter): Promise<boolean> {
  if (!/\/challenge\/selection/.test(page.url())) {
    // "Try another way" is NOT there the moment the security-key page loads: Google first
    // waits on the key, and only offers the alternative once that attempt is under way or
    // has failed. Probing once meant sometimes finding it and sometimes not — which is
    // exactly why the flow stopped in a different place on every run. Poll for it.
    const deadline = Date.now() + 20_000;
    let clicked: string | null = null;
    while (!clicked && Date.now() < deadline) {
      clicked =
        (await clickFirstMatching(page, [
          "a[href*='challenge/selection']",
          "[jsname='Cuz2Ue']",
        ])) ??
        (await clickButtonByText(page, [
          "try another way", "try another method", "more ways to verify",
          "試試其他方法", "试试其他方法",
          "尝试其他方式", "嘗試其他方式",
          "別の方法を試す", "다른 방법 시도",
          "otra forma", "autre méthode", "andere option",
        ]));
      if (!clicked) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!clicked) return false;
    logger.info({ clicked }, "Google 2FA - opened the verification-method picker");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
  }

  // The picker's entries are whole sentences ("從 Google Authenticator 應用程式取得驗證碼"),
  // so they have to be matched as substrings — a prefix match never fires on them.
  const picked =
    (await clickFirstMatching(page, [
      "[data-challengetype='6']",
      "li[data-challengetype='6'] div[role='link']",
      "a[href*='challenge/totp']",
    ])) ??
    (await clickButtonByText(
      page,
      [
        "google authenticator", "authenticator", "verification code",
        "驗證器應用程式", "验证器应用", "身分驗證器",
        "驗證碼", "验证码",
        "認証アプリ", "인증 앱",
      ],
      { contains: true, scope: "li, [role='listitem'], [role='link'], [data-challengetype], button, [role='button'], a" },
    ));
  if (!picked) return false;
  logger.info({ picked }, "Google 2FA - chose the authenticator option");
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  return !!(await page.$(TOTP_INPUT_SEL));
}

/**
 * Put Google's own screens into English before driving them.
 *
 * Every selector in this file that is not an id is a LABEL — "next", "continue", and the
 * handful of translations beside them — and Google does not pick that language from
 * anything we control. The site embeds the button without a `locale`, so for a signed-out
 * visitor Google decides from the exit IP as much as from Accept-Language: the same task
 * that renders "Sign in with Google" through one proxy renders "Conectează-te cu Google"
 * through a Romanian one. A flow that only works while the exit IP happens to be
 * English-speaking is not working, it is lucky.
 *
 * `hl` is Google's documented override and it survives the OAuth parameters, which are
 * carried in the query string and left untouched here. Nothing else about the request
 * changes, and choosing an interface language is an ordinary thing for an account to have
 * done — this is not a fingerprint the way an inconsistent navigator.language would be.
 */
async function forceEnglishGoogleUi(page: PageAdapter): Promise<void> {
  try {
    const url = page.url();
    if (!url.includes("accounts.google.com")) return;
    const u = new URL(url);
    if (u.searchParams.get("hl") === "en") return;
    u.searchParams.set("hl", "en");
    logger.info({ from: url, to: u.toString() }, "Forcing Google's UI to English (hl=en)");
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    // Never fatal: the id-based selectors still work in any language, and a failed
    // re-navigation must not cost a login that would otherwise have gone through.
    logger.warn({ err }, "Could not force Google's UI language — continuing in whatever it served");
  }
}

/** Google's "Next", resolved safely: the step's own id (scoped so we cannot stray to
 *  another button), then the localised label, then Enter. */
async function pressNext(page: PageAdapter, idSel: string, timeout: number): Promise<void> {
  // An open info dialog swallows every click underneath it.
  await closeBlockingDialog(page);
  const navPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout }).catch(() => {});
  const clicked =
    // The real <button> inside the wrapper first — #identifierNext itself is a DIV, and
    // clicking a wrapper is a coin flip on which child gets the event.
    (await clickFirstMatching(page, [`${idSel} button`, `${idSel} [role='button']`, idSel])) ??
    (await clickButtonByText(page, [
      "next", "continue", "下一步", "继续", "繼續", "次へ", "다음", "weiter", "suivant", "siguiente", "avanti", "далее",
    ]));
  if (!clicked) {
    logger.info({ idSel }, "No Next button matched — submitting with Enter");
    await page.keyboard.press("Enter");
  } else {
    logger.info({ clicked }, "Clicked Google Next");
  }
  await navPromise;
}

async function completeGoogleAuth(
  page: PageAdapter,
  credentials: GoogleCredentials,
  solver: CaptchaSolver | null,
): Promise<LoginResult> {
  const captchaResult = await detectAndHandleCaptcha(page, solver);
  if (captchaResult.detected && !captchaResult.solved) {
    if (captchaResult.needsAttention) {
      return { success: false, captchaBlocked: true, message: captchaResult.message };
    }
    logger.warn("Captcha on Google login page — proceeding anyway");
  }

  // Step 1: Enter email
  const emailSel = "input[type='email'], input[name='identifier'], input[autocomplete='username email']";
  try {
    await page.waitForSelector(emailSel, { timeout: 15000 });
  } catch {
    return { success: false, captchaBlocked: false, message: "Could not find email input on Google sign-in page" };
  }

  await focusField(page, emailSel);
  await page.evaluate((sel: unknown) => {
    const el = document.querySelector<HTMLInputElement>(sel as string);
    if (el) el.value = "";
  }, emailSel as never);
  await page.keyboard.type(credentials.username, { delay: 60 });

  // Click "Next" after email.
  //
  // The old selector list ended in `button[type='button']:not([disabled])`, and because
  // page.$() takes the first match in DOCUMENT order that fallback won: it matched the
  // app-name button ("Continue to <app>") which sits above the form, opening Google's
  // developer-info dialog instead of submitting. Try the precise ids one at a time, then
  // the localised label, and only then fall back to Enter (which Google honours anyway).
  await pressNext(page, "#identifierNext", 20000);

  await new Promise((r) => setTimeout(r, 1500));

  // Check for email error
  const emailError = await page.$(".o6cuMc, .dEOOab, [data-error-code]");
  if (emailError) {
    const errText = await emailError.evaluate((el: Element) => el.textContent ?? "");
    return { success: false, captchaBlocked: false, message: `Google login failed at email step: ${errText.trim()}` };
  }

  // Step 2: Enter password
  const passwordSel = "input[type='password'], input[name='password'], input[autocomplete='current-password']";
  try {
    await page.waitForSelector(passwordSel, { timeout: 15000 });
  } catch {
    return { success: false, captchaBlocked: false, message: "Could not find password input on Google sign-in page. Google may require additional verification." };
  }

  await focusField(page, passwordSel);
  await page.evaluate((sel: unknown) => {
    const el = document.querySelector<HTMLInputElement>(sel as string);
    if (el) el.value = "";
  }, passwordSel as never);
  await page.keyboard.type(credentials.password, { delay: 60 });

  // Click "Next" after password — same ordered resolution as the email step.
  await pressNext(page, "#passwordNext", 30000);

  await new Promise((r) => setTimeout(r, 1500));

  // Check for password error
  const passwordError = await page.$(".o6cuMc, .dEOOab, [jsname='B34EJ']");
  if (passwordError) {
    const errText = await passwordError.evaluate((el: Element) => el.textContent ?? "");
    if (errText.trim()) {
      return { success: false, captchaBlocked: false, message: `Google login failed at password step: ${errText.trim()}` };
    }
  }

  // Step 3: second factor.
  //
  // Google does not always land on the code entry form. When the account has a security key
  // registered it goes to /challenge/sk/webauthn first ("use your security key"), which no
  // automation can satisfy - but that page offers "Try another way", and the authenticator
  // app (the TOTP we hold) is one of the alternatives. The old code only looked for a code
  // input, did not find one, and gave up with "requires additional verification" while a
  // usable path was one click away.
  const secondFactorFailure = await resolveSecondFactor(page, credentials.totpSecret);
  if (secondFactorFailure) return secondFactorFailure;

  await dismissPopups(page);

  // Check we're no longer on Google auth pages
  const finalUrl = page.url();
  if (finalUrl.includes("accounts.google.com")) {
    // Check for blocking messages
    const blockedEl = await page.$("h1, .MuzmKe, .o6cuMc");
    const blockedText = blockedEl ? await blockedEl.evaluate((el: Element) => el.textContent ?? "") : "";
    logger.warn({ finalUrl, blockedText }, "Still on Google auth page after login attempt");

    if (finalUrl.includes("/challenge") || finalUrl.includes("/v3/signin")) {
      return { success: false, captchaBlocked: false, message: describeChallenge(finalUrl, "that could not be completed automatically") };
    }

    return { success: false, captchaBlocked: false, message: `Google login did not complete. Still on: ${finalUrl}. ${blockedText.trim()}` };
  }

  return { success: true, captchaBlocked: false, message: `Google auth completed. URL: ${finalUrl}` };
}

export async function googleLogin(
  page: PageAdapter,
  targetUrl: string,
  credentials: GoogleCredentials,
  solver: CaptchaSolver | null,
  successText?: string,
  successSelector?: string,
): Promise<LoginResult> {
  attachPopupHandler(page);

  try {
    logger.info({ targetUrl }, "Starting Google login flow");
    const timer = new PhaseTimer();
    await gotoTolerant(page, targetUrl, 60000);
    timer.mark("goto");

    // Clear a full-page Cloudflare interstitial BEFORE hunting for the OAuth button.
    // Without this the flow just searched a challenge page for 15 s and reported "could
    // not find a Sign in with Google button" — the button was behind the gate, not absent.
    // (form-login has always done this; the OAuth flows never did.)
    const cfCleared = await clearCloudflareInterstitial(page, { url: targetUrl });
    timer.mark("cloudflare");
    if (!cfCleared) {
      const stillBlocked = (await page
        .evaluate(() => !document.querySelector("input[type='password'], a[href*='oauth'], a[href*='login'], form"))
        .catch(() => false)) as boolean;
      if (stillBlocked) {
        return {
          success: false,
          captchaBlocked: true,
          message: timer.annotate(`Cloudflare challenge is still up — the login page never loaded. URL: ${page.url()}`),
        };
      }
    }

    const isAlreadyGoogle = page.url().includes("accounts.google.com");
    if (isAlreadyGoogle) await forceEnglishGoogleUi(page);
    // Set only when the flow moves into a popup; null means "we never left the site's page",
    // which is every redirect-flow site and therefore every site that works today.
    let sitePage: PageAdapter | null = null;
    // Where the flow started, so we can tell "OAuth completed" from "nothing happened".
    const clickStartUrl = page.url();

    if (!isAlreadyGoogle) {
      logger.info("Target is not Google — looking for OAuth button on target page");

      // Wait for page to fully render (SPA hydration, lazy-loaded buttons)
      await new Promise((r) => setTimeout(r, 2000));

      const captchaResult = await detectAndHandleCaptcha(page, solver);
      if (captchaResult.detected && !captchaResult.solved && captchaResult.needsAttention) {
        return { success: false, captchaBlocked: true, message: captchaResult.message };
      }

      // Retry finding the Google OAuth button with timeout
      let clicked = false;
      const deadline = Date.now() + 15000;
      while (!clicked && Date.now() < deadline) {
        clicked = await clickGoogleButton(page);
        if (!clicked) await new Promise((r) => setTimeout(r, 1000));
      }

      timer.mark("findButton");
      if (!clicked) {
        // "No button" has two very different causes and they need different fixes. The
        // page may genuinely lack one — or the site is ALREADY SIGNED IN, so there is
        // nothing left to sign in with.
        //
        // The step's own criterion decides that, and it decides it FIRST. Everywhere else
        // in this codebase a configured criterion is the authority and the heuristics are
        // guesses that only speak when nothing was configured — this branch had it the
        // other way round, asking detectLoginState and reporting failure on its "unknown".
        // Which is exactly what happened here: the OAuth completed, the page became the
        // signed-in dashboard, the button was correctly gone, the heuristic could not read
        // the new page, and a successful login was reported as "could not find a button".
        if (successText?.trim() || successSelector?.trim()) {
          const evidenceFound = await waitForSuccessCriterion(page, successSelector, successText);
          if (evidenceFound) {
            logger.info({ evidenceFound, url: page.url() }, "No OAuth button because the site is already signed in");
            return {
              success: true,
              captchaBlocked: false,
              message: timer.annotate(`Already signed in — ${evidenceFound}. Final URL: ${page.url()}`),
            };
          }
        }

        const { verdict, evidence } = await detectLoginState(page);
        const hint =
          verdict === "logged_in"
            ? ` The page looks ALREADY SIGNED IN (${evidence}) — the saved session is fine, but this step's success criterion did not recognise it, so the login ran anyway. Fix the criterion on the login step.`
            : verdict === "unknown"
              ? " The page shows neither a login button nor an account affordance — it may not have finished rendering, or the URL is not the login page."
              : " Ensure the target URL is a page that carries a Google OAuth login button.";
        return {
          success: false,
          captchaBlocked: false,
          message: timer.annotate(`Could not find a 'Sign in with Google' button on the target page after 15s.${hint}`),
        };
      }
      logger.info({ url: page.url() }, "Clicked the Google OAuth button — waiting for the flow to move");
      // WAIT for the click to actually go somewhere. Without this the very next check runs
      // while the browser is still on the login page and concludes "already authenticated
      // with Google" — which is why one test site reported success on every run while
      // sitting on the auth screen the whole time.
      //
      // "Somewhere" is two places, not one. A redirect flow navigates this page; a popup
      // flow (GSI's ux_mode:'popup', or the window.open fallback plenty of sites use)
      // leaves this page exactly where it was and does the whole exchange in another
      // window. Watching only the URL meant the popup case looked identical to a click
      // that never landed.
      const moved = async (): Promise<PageAdapter | null> => {
        const navDeadline = Date.now() + 20000;
        while (Date.now() < navDeadline) {
          const u = page.url();
          if (u.includes("accounts.google.com") || u !== clickStartUrl) return page;
          const popup = (await page
            .getOpenPages()
            .find((pg) => {
              try {
                return !pg.isClosed() && pg.url().includes("accounts.google.com");
              } catch {
                return false;
              }
            })) as PageAdapter | undefined;
          if (popup) return popup;
          await new Promise((r) => setTimeout(r, 500));
        }
        return null;
      };

      let arrived = await moved();

      // Nothing moved: the page may have handed our click to a Google button it keeps
      // hidden, which swallows it. Reveal that button and click it for real, then wait
      // again. Only reached when the ordinary path produced nothing, so a site where the
      // ordinary path works never takes it.
      if (!arrived) {
        if (await clickHiddenGoogleButton(page)) {
          arrived = await moved();
        }
      }

      if (arrived && arrived !== page) {
        logger.info({ url: arrived.url() }, "Google opened its own window — following it");
        // The SITE's page stays where it is. The popup is only where the credentials are
        // typed; the sign-in itself lands back on the opener, which is also the only page
        // the success criterion can be checked against — and by then the popup is closed.
        sitePage = page;
        page = arrived;
      }
      timer.mark("oauthRedirect");
      await forceEnglishGoogleUi(page);
    }

    if (!page.url().includes("accounts.google.com")) {
      // Maybe already logged into Google and got redirected directly back to app
      logger.info({ url: page.url() }, "Not on accounts.google.com — checking whether we are actually signed in");
      // "Not on Google" is NOT evidence of a session: it is also what a page that never
      // moved looks like. Demand something on the page that says we are in.
      const landingErr = await verifyOAuthLanding(page, "Google", clickStartUrl);
      if (landingErr) {
        return { success: false, captchaBlocked: false, message: timer.annotate(landingErr) };
      }
      // 如果配置了 successText，验证页面含该文本才算已登录
      //
      // WAITS, and matches the way every other login path matches. This was a single look
      // 1.5s after landing, compared raw against innerText — see success-text.ts for the
      // three ways that got a successful login reported as a failure.
      if (successText) {
        const found = await waitForSuccessCriterion(page, undefined, successText);
        if (!found) {
          return { success: false, captchaBlocked: false, message: `Login completed but success text "${successText}" not found on page. URL: ${page.url()}` };
        }
      }
      if (successSelector) {
        try {
          const el = await page.$(successSelector);
          const visible = el ? await el.evaluate((e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).catch(() => false) : false;
          if (!visible) {
            return { success: false, captchaBlocked: false, message: `Login completed but success selector "${successSelector}" not visible. URL: ${page.url()}` };
          }
        } catch { /* 选择器无效，跳过 */ }
      }
      return { success: true, captchaBlocked: false, message: `Already authenticated via Google. Final URL: ${page.url()}` };
    }

    const result = await completeGoogleAuth(page, credentials, solver);
    timer.mark("googleAuth");
    if (!result.success) return { ...result, message: timer.annotate(result.message) };

    // Back to the opener for the verdict, when there was one. The popup closes as soon as
    // Google hands the credential over, so every check below would be reading a dead page.
    if (sitePage) {
      logger.info({ url: sitePage.url() }, "Google's window is done — verifying on the site's page");
      page = sitePage;
      // The opener finishes its own sign-in when the credential arrives; give it that.
      await new Promise((r) => setTimeout(r, 3000));
    }

    const finalUrl = page.url();
    logger.info({ finalUrl }, "Google login succeeded");
    // 如果配置了 successText，验证页面含该文本才算登录成功
    //
    // Same shared wait as above. A Google login that had genuinely succeeded was failed
    // here, retried against a site that was now signed in (so no OAuth button existed), and
    // its session was therefore never saved — so the next run repeated the whole flow, TOTP
    // included, every single day.
    if (successText) {
      const found = await waitForSuccessCriterion(page, undefined, successText);
      if (!found) {
        return { success: false, captchaBlocked: false, message: `Login completed but success text "${successText}" not found on page. URL: ${finalUrl}` };
      }
    }
    if (successSelector) {
      try {
        const el = await page.$(successSelector);
        const visible = el ? await el.evaluate((e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).catch(() => false) : false;
        if (!visible) {
          return { success: false, captchaBlocked: false, message: `Login completed but success selector "${successSelector}" not visible. URL: ${finalUrl}` };
        }
      } catch { /* 选择器无效，跳过 */ }
    }
    const finalLandingErr = await verifyOAuthLanding(page, "Google");
    if (finalLandingErr) return { success: false, captchaBlocked: false, message: finalLandingErr };
    return { success: true, captchaBlocked: false, message: `Successfully logged in via Google OAuth. Final URL: ${finalUrl}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Google login error");
    return { success: false, captchaBlocked: false, message: `Google login error: ${message}` };
  // (the timer is scoped inside the try; a throw here is already annotated by its own phase)
  }
}
