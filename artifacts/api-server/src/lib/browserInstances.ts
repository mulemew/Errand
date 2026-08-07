import { createBrowserProvider, type BrowserProvider, type BrowserProviderConfig } from "../automation/browser-provider";
import type { PageAdapter } from "../automation/page-adapter";
import { logger } from "../lib/logger";
import { clearView } from "../lib/taskViews";

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
 */
export interface BrowserInstance {
  id: string;
  name: string;
  providerId: number | null;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  createdAt: number;
  lastUsedAt: number;
  url: string;
  provider: BrowserProvider;
  page: PageAdapter;
  /** Playwright storageState dumper, when the backend supports one. */
  dumpStorageState: (() => Promise<unknown>) | null;
}

const instances = new Map<string, BrowserInstance>();

export function listInstances(): Array<Omit<BrowserInstance, "provider" | "page" | "dumpStorageState">> {
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
  startUrl?: string;
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
  if (opts.startUrl) {
    await page.goto(opts.startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
      logger.warn({ err, url: opts.startUrl }, "Browser instance could not open its start URL");
    });
  }

  const inst: BrowserInstance = {
    id,
    name: opts.name,
    providerId: opts.providerId,
    fingerprintProfileId: opts.fingerprintProfileId,
    proxyProfileId: opts.proxyProfileId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    url: (() => {
      try {
        return page.url();
      } catch {
        return opts.startUrl ?? "about:blank";
      }
    })(),
    provider,
    page,
    dumpStorageState: dumper,
  };
  instances.set(id, inst);
  logger.info({ id, name: opts.name, providerId: opts.providerId }, "Browser instance launched");
  return inst;
}

export async function stopInstance(id: string): Promise<boolean> {
  const inst = instances.get(id);
  if (!inst) return false;
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
