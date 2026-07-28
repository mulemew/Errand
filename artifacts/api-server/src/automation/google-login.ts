import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { attachPopupHandler, dismissPopups } from "./popup-handler";
import { verifyOAuthLanding, clickFirstMatching, clickButtonByText, closeBlockingDialog, gotoTolerant, PhaseTimer } from "./login-verify";
import { clearCloudflareInterstitial } from "./cloudflare-bypass";
import { detectAndHandleCaptcha } from "./captcha";
import type { CaptchaSolver } from "./captcha-solver";
import type { LoginResult } from "./form-login";

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

const TOTP_INPUT_SEL =
  "input[type='tel'], input[name='totpPin'], input[autocomplete='one-time-code'], input[inputmode='numeric']";

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

    const totpInput = await page.$(TOTP_INPUT_SEL);
    if (totpInput) {
      if (!totpSecret) {
        return {
          success: false,
          captchaBlocked: false,
          message:
            "Google is asking for a 2FA code but this credential has no TOTP secret. " +
            "Add the authenticator secret to the saved credential.",
        };
      }
      const { generateSync } = await import("otplib");
      const totp = generateSync({ secret: totpSecret });
      logger.info({ round }, "Google 2FA - entering an authenticator code");
      await page.click(TOTP_INPUT_SEL);
      await page.keyboard.type(totp, { delay: 80 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
        page.keyboard.press("Enter"),
      ]);
      await new Promise((r) => setTimeout(r, 1500));
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
    const clicked =
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
    if (!clicked) return false;
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
  }

  const picked =
    (await clickFirstMatching(page, [
      "[data-challengetype='6']",
      "li[data-challengetype='6'] div[role='link']",
      "a[href*='challenge/totp']",
    ])) ??
    (await clickButtonByText(page, [
      "google authenticator", "authenticator app", "get a verification code",
      "驗證器應用程式", "验证器应用",
      "身分驗證器", "輸入驗證碼", "输入验证码",
      "認証アプリ", "인증 앱",
    ]));
  if (!picked) return false;
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  return !!(await page.$(TOTP_INPUT_SEL));
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

  await page.click(emailSel);
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

  await page.click(passwordSel);
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
        return {
          success: false,
          captchaBlocked: false,
          message: timer.annotate("Could not find a 'Sign in with Google' button on the target page after 15s. Ensure the target URL contains a Google OAuth login button."),
        };
      }
      logger.info({ url: page.url() }, "Clicked the Google OAuth button — waiting for the flow to move");
      // WAIT for the click to actually go somewhere. Without this the very next check runs
      // while the browser is still on the login page and concludes "already authenticated
      // with Google" — which is why dash.pingless.org reported success on every run while
      // sitting on the auth screen the whole time.
      const navDeadline = Date.now() + 20000;
      while (Date.now() < navDeadline) {
        const u = page.url();
        if (u.includes("accounts.google.com") || u !== clickStartUrl) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      timer.mark("oauthRedirect");
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
      if (successText) {
        await new Promise((r) => setTimeout(r, 1500));
        const hasText = await page.evaluate(
          (t: unknown) => (document.body?.innerText ?? "").includes(t as string),
          successText as never,
        ).catch(() => false) as boolean;
        if (!hasText) {
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

    const finalUrl = page.url();
    logger.info({ finalUrl }, "Google login succeeded");
    // 如果配置了 successText，验证页面含该文本才算登录成功
    if (successText) {
      await new Promise((r) => setTimeout(r, 1500));
      const hasSuccessText = await page.evaluate(
        (t: unknown) => (document.body?.innerText ?? "").includes(t as string),
        successText as never,
      ).catch(() => false) as boolean;
      if (!hasSuccessText) {
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
