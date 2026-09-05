import { createBrowserProvider, type BrowserProvider, type BrowserProviderConfig } from "../automation/browser-provider";
import type { PageAdapter } from "../automation/page-adapter";
import { logger } from "../lib/logger";
import { clearView } from "../lib/taskViews";
import { saveSessionProfileState, createSessionProfile } from "../lib/browserSessionStore";

/**
 * Long-lived browsers you drive by hand.
 *
 * A task's browser exists for the length of a run and then goes away — deliberately, so no
 * run can inherit another's state. These are the opposite: an environment (provider +
 * fingerprint + proxy) held open until you close it, so you can register an account or pass
 * a challenge yourself and then hand the resulting session to a task that will run in the
 * SAME environment. That is the whole point — same fingerprint, same exit IP, same cookies.
 *
 * Kept in memory on purpose: the instance IS the live browser. Nothing here survives a
 * restart, and it should not pretend to — the sidecar's own TTL reaps whatever is orphaned.
 *
 * The session profile it is bound to DOES survive: an instance opened from one writes its
 * cookies back on close, and the row also carries the provider/fingerprint/proxy, so
 * reopening lands in the same environment rather than merely the same cookies.
 *
 * Limit: a storage state is cookies and localStorage only. Sites keeping their login in
 * IndexedDB will ask you to sign in again.
 */
export interface BrowserInstance {
  id: string;
  name: string;
  providerId: number | null;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  /** The profile this browser was opened from, and the one it saves back into on close. */
  sessionProfileId: number | null;
  createdAt: number;
  lastUsedAt: number;
  url: string;
  provider: BrowserProvider;
  /** Reassigned when the tracked tab is closed and another is still open — see pruneDeadInstances. */
  page: PageAdapter;
  /** Playwright storageState dumper, when the backend supports one. */
  dumpStorageState: (() => Promise<unknown>) | null;
}

/** How long a session dump may take before the close gives up on it. */
const SESSION_DUMP_TIMEOUT_MS = 15_000;

const instances = new Map<string, BrowserInstance>();

/**
 * Forget instances whose browser is gone.
 *
 * The sidecar can take a session down without telling us — its age reaper used to do
 * exactly that at 90 minutes — and the map kept listing the browser as running long after
 * there was nothing behind it. You could still see it, still press things, and the only
 * symptom was a live view with no screen to show.
 *
 * Nothing is saved here: the page is already closed, so there is no session left to dump,
 * and the stored profile keeps whatever it had.
 */
function pruneDeadInstances(): void {
  for (const [id, inst] of instances) {
    let dead = false;
    try {
      dead = inst.page.isClosed();
    } catch {
      dead = true;
    }
    // A closed TAB is not a closed browser. Opening a second tab and closing the first is
    // an ordinary thing to do in a browser you are driving by hand, and it used to take the
    // whole instance down with it: the tracked page was closed, so this called the browser
    // dead and shut it down under the person using it. Adopt a surviving tab instead — and
    // it becomes the one whose URL is saved on close, which is the right one anyway.
    if (dead) {
      try {
        const alive = inst.page.getOpenPages().find((pg) => !pg.isClosed());
        if (alive) {
          inst.page = alive;
          logger.info({ id, name: inst.name, url: alive.url() }, "Tracked tab was closed — following the surviving one");
          continue;
        }
      } catch { /* the context itself is gone; fall through to dropping it */ }
    }
    if (!dead) continue;
    instances.delete(id);
    clearView(id);
    logger.warn({ id, name: inst.name }, "Browser instance vanished — dropping it from the list");
    void inst.provider.close().catch(() => {});
  }
}

export function listInstances(): Array<Omit<BrowserInstance, "provider" | "page" | "dumpStorageState">> {
  pruneDeadInstances();
  return [...instances.values()].map(({ provider: _p, page: _pg, dumpStorageState: _d, ...rest }) => ({
    ...rest,
    url: (() => {
      try {
        return instances.get(rest.id)!.page.url();
      } catch {
        return rest.url;
      }
    })(),
  }));
}

export function getInstance(id: string): BrowserInstance | undefined {
  return instances.get(id);
}

export async function launchInstance(opts: {
  name: string;
  config: BrowserProviderConfig;
  providerId: number | null;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  sessionProfileId?: number | null;
  startUrl?: string;
  /** The other tabs that were open at close. The first page goes to startUrl. */
  restoreTabs?: string[];
}): Promise<BrowserInstance> {
  let dumper: (() => Promise<unknown>) | null = null;
  // The id has to exist BEFORE the browser starts: it is also the name the sidecar's
  // per-session display gets registered under, and that registration happens during launch.
  const id = `bi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const config: BrowserProviderConfig = {
    ...opts.config,
    viewKey: id,
    // Same hook the runner uses to persist cookie-mode sessions; here it is what lets a
    // hand-driven login be saved as a profile.
    onContextReady: (d: () => Promise<unknown>) => {
      dumper = d;
    },
  } as BrowserProviderConfig;

  const provider = createBrowserProvider(config);
  const page = await provider.newPage();
  const startUrl = normalizeStartUrl(opts.startUrl);

  const inst: BrowserInstance = {
    id,
    name: opts.name,
    providerId: opts.providerId,
    fingerprintProfileId: opts.fingerprintProfileId,
    proxyProfileId: opts.proxyProfileId,
    sessionProfileId: opts.sessionProfileId ?? null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    // Where it is going, not where it is: the navigation happens below, after this
    // returns, and "about:blank" for the next few seconds is not what anyone wants to read.
    url: startUrl || opts.startUrl || "about:blank",
    provider,
    page,
    dumpStorageState: dumper,
  };
  instances.set(id, inst);

  // WHERE IT GOES IS NOT PART OF STARTING IT.
  //
  // Navigation used to happen before this function returned, so the live view did not
  // appear until every page had finished loading — measured on a browser with a start page
  // and one restored tab: 2.3s to start the browser, then 7.5s of waiting at a blank
  // screen. You are looking at the browser while it loads, which is what a browser looks
  // like. So the pages arrive behind the window.
  //
  // Sequential and best-effort: one site that refuses to load must not cost the others, and
  // a burst of parallel navigations through a single proxy is a good way to fail several.
  const extraTabs = (opts.restoreTabs ?? [])
    .map((u) => normalizeStartUrl(u))
    .filter((u): u is string => !!u);
  // The first page is already showing one of these. Remove ONE of them — filtering every
  // match dropped both halves of a window that had the same site open twice.
  if (startUrl) {
    const first = extraTabs.indexOf(startUrl);
    if (first >= 0) extraTabs.splice(first, 1);
  }
  if (startUrl || extraTabs.length) {
    void (async () => {
      // THE TABS FIRST, THEN THE START PAGE.
      //
      // The other order chained them: navigate, then open the rest. A start page that took
      // its full 60-second timeout to fail — measured, on a real launch — held every other
      // tab behind it, so a restored window appeared one tab at a time over a minute.
      //
      // Nothing is waiting on the navigation, so it does not have to go first. The tabs are
      // opened out of the blank page the browser starts on, which takes well under a second
      // for a whole window, and only then does the first tab go where it is going.
      if (extraTabs.length && typeof page.openTab === "function") {
        let opened = 0;
        for (const url of extraTabs) {
          // Closed while its tabs were still coming back; nothing left to open into.
          if (!instances.has(id)) return;
          try {
            await page.openTab(url);
            opened++;
          } catch (err) {
            logger.warn({ err, url }, "Could not restore a tab");
          }
        }
        logger.info({ id, opened, of: extraTabs.length }, "Restored the tabs that were open at close");
      }
      if (!instances.has(id)) return;
      if (startUrl) {
        await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
          logger.warn({ err, url: startUrl }, "Browser instance could not open its start URL");
        });
      }
      // Opening a tab focuses it, so the window would otherwise come up showing the last
      // restored tab. You left it on the first one.
      try {
        await page.bringToFront?.();
      } catch { /* not worth a line in the log */ }
    })();
  }
  logger.info({ id, name: opts.name, providerId: opts.providerId }, "Browser instance launched");
  return inst;
}

/**
 * Every tab worth reopening, in the order the context reports them.
 *
 * Blank tabs and internal pages are dropped — restoring `about:blank` five times is not
 * restoring anything — and the list is capped so a runaway page that spawns tabs cannot
 * turn one close into a hundred launches on the next open.
 */
/**
 * What a person means when they type an address.
 *
 * `page.goto("www.baidu.com")` does not navigate — it throws `Invalid url`, because
 * Playwright hands the string to the protocol as-is and a URL without a scheme is not a
 * URL. Every browser's address bar fills the scheme in silently, so a field that looks
 * like an address bar and refuses what an address bar accepts is just wrong.
 *
 * https, not http: this opens real sites, and starting in the clear invites a redirect
 * that a proxy in the middle could rewrite. A site that genuinely only speaks http can be
 * given its scheme explicitly, which is the case worth making someone type.
 */
export function normalizeStartUrl(raw: string | null | undefined): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    // Not salvageable — let the caller open a blank page rather than throw at launch.
    return undefined;
  }
}

const MAX_RESTORED_TABS = 20;

/**
 * The tab list, from whoever can actually see it.
 *
 * Firefox's own session store first: it is the only source that includes tabs opened from
 * the browser's UI, which is how a person actually opens them. Playwright's view is merged
 * in behind it — it can hold a page the store has not been refreshed with yet, since the
 * store is written every few seconds rather than on every change.
 */
async function collectTabsToRestore(inst: BrowserInstance): Promise<string[]> {
  let fromBrowser: string[] = [];
  try {
    fromBrowser = (await inst.provider.listOpenTabs?.()) ?? [];
  } catch {
    /* the backend cannot answer; Playwright's view is still something */
  }
  // Two tabs on the same page are two tabs — the list is a sequence, not a set of
  // addresses. Collecting into a Set collapsed them and a window with the same site open
  // twice came back with one of it.
  //
  // The two sources overlap almost entirely, so they are merged by COUNT: for each address,
  // however many of it the more informed source saw. Concatenating would double every tab;
  // merging by membership — which is what this did first — silently dropped the second copy
  // of an address the other source already listed, which is the same bug again in a new
  // place. Firefox's list leads, because it is the one that includes tabs opened by hand.
  const fromPlaywright = collectOpenUrls(inst);
  const tally = (urls: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const u of urls) m.set(u, (m.get(u) ?? 0) + 1);
    return m;
  };
  const seen = tally(fromBrowser);
  const live = tally(fromPlaywright);
  const merged = [...fromBrowser];
  for (const [url, n] of live) {
    // Only the copies the store has not caught up with; it writes on a timer, so a tab
    // opened moments before closing can still be missing from it.
    for (let i = seen.get(url) ?? 0; i < n; i++) merged.push(url);
  }
  return merged.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_RESTORED_TABS);
}

function collectOpenUrls(inst: BrowserInstance): string[] {
  try {
    const urls: string[] = [];
    // The whole browser, falling back to this context. A tab the person opened themselves
    // is not necessarily in the context automation created — measured, a session with
    // several tabs open reported exactly one page from the context alone.
    const pages = inst.page.getAllPages?.() ?? inst.page.getOpenPages();
    for (const pg of pages) {
      let u = "";
      try {
        u = pg.url();
      } catch {
        continue;
      }
      if (!/^https?:\/\//i.test(u)) continue;
      urls.push(u);
      if (urls.length >= MAX_RESTORED_TABS) break;
    }
    return urls;
  } catch {
    return [];
  }
}

/** Logged on every close: "restored nothing" and "there was nothing to restore" look
 *  identical from the outside, and only one of them is a bug. */
function logCollectedTabs(inst: BrowserInstance, urls: string[]): void {
  const count = (f: () => PageAdapter[] | undefined): number => {
    try {
      return f()?.length ?? -1;
    } catch {
      return -1;
    }
  };
  logger.info(
    {
      id: inst.id,
      pagesInContext: count(() => inst.page.getOpenPages()),
      pagesInBrowser: count(() => inst.page.getAllPages?.()),
      kept: urls.length,
      urls,
    },
    "Tabs recorded for reopening",
  );
}

export async function stopInstance(id: string): Promise<boolean> {
  const inst = instances.get(id);
  if (!inst) return false;

  // Closing KEEPS the browser: one opened from a profile writes back into it, one created
  // from scratch becomes a profile. Deleting the profile is what destroys it.
  //
  // The dump must happen before the context closes, and is bounded — an unresponsive
  // browser would otherwise hold the close open, including stopAllInstances on shutdown.
  try {
    const state = await Promise.race([
      dumpInstanceSession(inst),
      new Promise<null>((r) => setTimeout(() => r(null), SESSION_DUMP_TIMEOUT_MS)),
    ]);
    if (!state) {
      // Not destructive: a failed dump leaves an existing profile as it was, and does not
      // create an empty one that would look like a session that expired.
      logger.warn({ id }, "Nothing to save on close");
    } else if (inst.sessionProfileId != null) {
      await saveSessionProfileState(inst.sessionProfileId, state, {
        originUrl: (() => {
          try {
            return inst.page.url();
          } catch {
            return null;
          }
        })(),
        openUrls: await (async () => {
          const urls = await collectTabsToRestore(inst);
          logCollectedTabs(inst, urls);
          return urls;
        })(),
      });
      logger.info({ id, sessionProfileId: inst.sessionProfileId }, "Session written back to its profile");
    } else {
      const newId = await createSessionProfile({
        name: inst.name,
        state,
        providerId: inst.providerId,
        fingerprintProfileId: inst.fingerprintProfileId,
        proxyProfileId: inst.proxyProfileId,
        originUrl: (() => {
          try {
            return inst.page.url();
          } catch {
            return null;
          }
        })(),
      });
      if (newId != null) logger.info({ id, sessionProfileId: newId }, "Closed browser saved so it can be reopened");
    }
  } catch (err) {
    logger.warn({ err, id }, "Could not save the session on close");
  }

  instances.delete(id);
  clearView(id);
  try {
    await inst.provider.close();
  } catch (err) {
    logger.warn({ err, id }, "Browser instance did not close cleanly");
  }
  logger.info({ id }, "Browser instance stopped");
  return true;
}

/** Close everything — called on shutdown so a restart does not strand sidecar sessions. */
export async function stopAllInstances(): Promise<void> {
  await Promise.all([...instances.keys()].map((id) => stopInstance(id)));
}

/**
 * The current session (cookies + localStorage) of an instance.
 *
 * Prefers the Playwright storageState dumper; falls back to the cookie jar the SeleniumBase
 * adapter exposes, which is all that backend can give and is still enough for cookie mode.
 */
export async function dumpInstanceSession(inst: BrowserInstance): Promise<unknown | null> {
  inst.lastUsedAt = Date.now();
  if (inst.dumpStorageState) {
    try {
      return await inst.dumpStorageState();
    } catch (err) {
      logger.warn({ err, id: inst.id }, "storageState dump failed — trying the cookie jar");
    }
  }
  const p = inst.page as unknown as { getCookies?: () => Promise<Array<Record<string, unknown>>> };
  if (typeof p.getCookies === "function") {
    try {
      const cookies = await p.getCookies();
      return { cookies, origins: [] };
    } catch (err) {
      logger.warn({ err, id: inst.id }, "cookie jar dump failed");
    }
  }
  return null;
}
