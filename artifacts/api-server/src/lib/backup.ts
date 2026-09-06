/**
 * A backup you can actually restore somewhere else.
 *
 * The existing task export is a list of tasks and nothing they point at. Every task carries
 * `fingerprintProfileId`, `proxyProfileId`, `groupId`, a `browserConfig` holding more ids,
 * and steps naming a `credentialId` — counted on a live install: 34 of 34 tasks referenced a
 * fingerprint, 33 a proxy, 28 a credential. Import that file into an empty instance and you
 * get 34 tasks pointing at rows that do not exist. It is a template, not a backup.
 *
 * So this takes the whole graph and renumbers it on the way in. Ids in a new database are
 * whatever `serial` hands out, so the file keeps the ORIGINAL ids and the restore builds
 * old→new maps table by table, in dependency order, rewriting every reference as it goes —
 * including the ones buried in JSON.
 *
 * ── On the file being encrypted, and why with a passphrase ───────────────────────────────
 *
 * Secrets in this database are encrypted with the instance's ENCRYPTION_KEY. Exporting that
 * ciphertext as-is would produce a file that only restores where that key already is — which
 * is not a backup, it is a replica, and the machine you are restoring FROM is often the one
 * you no longer have. So secrets are decrypted here and the whole file is sealed under a key
 * derived from a passphrase you choose. Restoring re-encrypts everything with the new
 * instance's own key.
 *
 * The WHOLE file, not just the password fields: a backup lists every site you automate and
 * every proxy URL, and proxy URLs carry their own credentials. The non-secret half is not
 * the harmless half.
 *
 * scrypt and AES-256-GCM because both are already in this codebase (passwordStore and
 * encryption.ts) and in Node itself — a backup format should not depend on a package.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import {
  db,
  tasksTable,
  taskGroupsTable,
  fingerprintProfilesTable,
  proxyProfilesTable,
  providersTable,
  savedCredentialsTable,
  credentialsTable,
  sessionProfilesTable,
  browserSessionsTable,
  settingsTable,
} from "@workspace/db";
import { encrypt, decrypt } from "./encryption";
import { logger } from "./logger";

// ── The sealed file ───────────────────────────────────────────────────────────

/** Cost parameters, stored in the file so a future change cannot orphan old backups. */
const KDF = { algo: "scrypt" as const, N: 65536, r: 8, p: 1, keylen: 32 };

export interface SealedBackup {
  format: "errand-backup";
  version: 1;
  createdAt: string;
  kdf: typeof KDF & { salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must allow N*r*128 plus slack, or scrypt refuses at these parameters.
    scryptCb(
      passphrase,
      salt,
      KDF.keylen,
      { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * KDF.N * KDF.r },
      (err, key) => (err ? reject(err) : resolve(key as Buffer)),
    );
  });
}

export async function seal(payload: unknown, passphrase: string): Promise<SealedBackup> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    format: "errand-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    kdf: { ...KDF, salt: salt.toString("hex") },
    cipher: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("base64"),
  };
}

/** Throws a message meant for a person: the only two failures are a wrong passphrase and a
 *  file that is not one of ours, and they must not look alike. */
export async function open(file: unknown, passphrase: string): Promise<BackupPayload> {
  const f = file as Partial<SealedBackup>;
  if (!f || f.format !== "errand-backup") {
    throw new Error("This is not an Errand backup file.");
  }
  if (f.version !== 1) {
    throw new Error(`This backup says version ${String(f.version)}; this build only reads version 1.`);
  }
  if (!f.kdf?.salt || !f.iv || !f.tag || !f.data) {
    throw new Error("This backup file is incomplete.");
  }
  const salt = Buffer.from(f.kdf.salt, "hex");
  // The file's own parameters, not the current constants: a backup made before a cost
  // change must still open.
  const key = await new Promise<Buffer>((resolve, reject) =>
    scryptCb(
      passphrase,
      salt,
      f.kdf!.keylen ?? KDF.keylen,
      {
        N: f.kdf!.N ?? KDF.N,
        r: f.kdf!.r ?? KDF.r,
        p: f.kdf!.p ?? KDF.p,
        maxmem: 256 * (f.kdf!.N ?? KDF.N) * (f.kdf!.r ?? KDF.r),
      },
      (err, k) => (err ? reject(err) : resolve(k as Buffer)),
    ),
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "hex"));
    decipher.setAuthTag(Buffer.from(f.tag, "hex"));
    const out = Buffer.concat([decipher.update(Buffer.from(f.data, "base64")), decipher.final()]);
    return JSON.parse(out.toString("utf8")) as BackupPayload;
  } catch {
    // GCM fails the tag check on a wrong key; there is nothing else it can be.
    throw new Error("Wrong passphrase — this backup could not be opened.");
  }
}

// ── What is in it ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export interface BackupPayload {
  version: 1;
  exportedAt: string;
  includesSessions: boolean;
  groups: Row[];
  fingerprints: Row[];
  proxies: Row[];
  providers: Row[];
  /** Decrypted here, re-encrypted on restore under the new instance's key. */
  savedCredentials: Array<Row & { data: unknown }>;
  tasks: Row[];
  taskCredentials: Array<{ taskId: number; data: unknown }>;
  sessionProfiles: Array<Row & { state: unknown }>;
  browserSessions: Array<{ taskId: number; sessionKey: string; state: unknown }>;
  settings: Array<{ key: string; value: string }>;
}

/** Read a stored `{enc}` blob, or null when it cannot be read with this instance's key. */
function readEnc(v: unknown): unknown {
  const raw = (v as { enc?: string } | null)?.enc;
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw));
  } catch {
    return null;
  }
}

export async function collect(opts: { includeSessions: boolean }): Promise<BackupPayload> {
  const [groups, fingerprints, proxies, providers, saved, tasks, taskCreds, settings] =
    await Promise.all([
      db.select().from(taskGroupsTable),
      db.select().from(fingerprintProfilesTable),
      db.select().from(proxyProfilesTable),
      db.select().from(providersTable),
      db.select().from(savedCredentialsTable),
      db.select().from(tasksTable),
      db.select().from(credentialsTable),
      db.select().from(settingsTable),
    ]);

  const sessionProfiles = opts.includeSessions ? await db.select().from(sessionProfilesTable) : [];
  const browserSessions = opts.includeSessions ? await db.select().from(browserSessionsTable) : [];

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    includesSessions: opts.includeSessions,
    groups: groups as Row[],
    fingerprints: fingerprints as Row[],
    proxies: proxies as Row[],
    providers: providers as Row[],
    savedCredentials: (saved as Row[]).map((c) => ({
      id: c.id,
      name: c.name,
      username: c.username,
      data: readEnc({ enc: c.encryptedData as string }),
    })),
    tasks: tasks as Row[],
    taskCredentials: (taskCreds as Row[]).map((c) => ({
      taskId: c.taskId as number,
      data: readEnc({ enc: c.encryptedData as string }),
    })),
    sessionProfiles: (sessionProfiles as Row[]).map((s) => ({
      ...s,
      state: readEnc(s.storageState),
    })),
    browserSessions: (browserSessions as Row[]).map((s) => ({
      taskId: s.taskId as number,
      sessionKey: (s.sessionKey as string) ?? "default",
      state: readEnc(s.storageState),
    })),
    settings: (settings as Row[]).map((s) => ({ key: s.key as string, value: s.value as string })),
  };
}

// ── Putting it back ───────────────────────────────────────────────────────────

/** Old id → new id, per table. */
type Remap = Map<number, number>;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Follow a map, leaving anything it does not cover alone rather than nulling it. */
const via = (map: Remap, v: unknown): unknown => {
  const id = num(v);
  if (id == null) return v;
  return map.get(id) ?? null;
};

export interface RestoreReport {
  groups: number;
  fingerprints: number;
  proxies: number;
  providers: number;
  savedCredentials: number;
  tasks: number;
  taskCredentials: number;
  sessionProfiles: number;
  browserSessions: number;
  settings: number;
  skipped: string[];
}

/**
 * ADDITIVE. Nothing existing is updated or deleted — a restore into a populated instance
 * adds to it, and a mistake is undone by deleting what was added. Settings are the one
 * thing that would have to overwrite to be useful, so they are only written where the key
 * is absent.
 *
 * Imported tasks arrive disabled. A backup restored onto a machine that can reach the same
 * sites would otherwise start running schedules the moment it lands.
 */
export async function restore(payload: BackupPayload): Promise<RestoreReport> {
  const report: RestoreReport = {
    groups: 0, fingerprints: 0, proxies: 0, providers: 0, savedCredentials: 0,
    tasks: 0, taskCredentials: 0, sessionProfiles: 0, browserSessions: 0, settings: 0,
    skipped: [],
  };
  const gMap: Remap = new Map();
  const fMap: Remap = new Map();
  const pMap: Remap = new Map();
  const provMap: Remap = new Map();
  const credMap: Remap = new Map();
  const taskMap: Remap = new Map();

  // One transaction for the whole graph: a restore that fails halfway would otherwise leave
  // tasks pointing at half-inserted profiles, which is worse than not restoring at all.
  await db.transaction(async (tx) => {
    for (const g of payload.groups ?? []) {
      const [row] = await tx
        .insert(taskGroupsTable)
        .values({ name: String(g.name ?? "group"), sortOrder: num(g.sortOrder) ?? 0 })
        .returning({ id: taskGroupsTable.id });
      if (num(g.id) != null) gMap.set(num(g.id)!, row.id);
      report.groups++;
    }

    for (const f of payload.fingerprints ?? []) {
      const [row] = await tx
        .insert(fingerprintProfilesTable)
        .values({
          name: String(f.name ?? "fingerprint"),
          os: String(f.os ?? "windows"),
          config: (f.config ?? null) as never,
        })
        .returning({ id: fingerprintProfilesTable.id });
      if (num(f.id) != null) fMap.set(num(f.id)!, row.id);
      report.fingerprints++;
    }

    for (const p of payload.proxies ?? []) {
      const [row] = await tx
        .insert(proxyProfilesTable)
        .values({
          name: String(p.name ?? "proxy"),
          url: String(p.url ?? ""),
          // The exit IP is a measurement of where this instance came out, not a property of
          // the proxy. It is re-checked here rather than restored as fact.
          exitGeo: null,
        })
        .returning({ id: proxyProfilesTable.id });
      if (num(p.id) != null) pMap.set(num(p.id)!, row.id);
      report.proxies++;
    }

    for (const p of payload.providers ?? []) {
      const [row] = await tx
        .insert(providersTable)
        .values({
          name: String(p.name ?? "provider"),
          type: String(p.type ?? "playwright"),
          url: String(p.url ?? ""),
          concurrency: num(p.concurrency) ?? 1,
          stealth: (p.stealth as boolean | null) ?? null,
          blockAds: (p.blockAds as boolean | null) ?? null,
          ignoreHttps: (p.ignoreHttps as boolean | null) ?? null,
          sessionTimeoutMs: num(p.sessionTimeoutMs),
          viewportWidth: num(p.viewportWidth),
          viewportHeight: num(p.viewportHeight),
          humanize: (p.humanize as boolean | null) ?? null,
          blockWebrtc: (p.blockWebrtc as boolean | null) ?? null,
        })
        .returning({ id: providersTable.id });
      if (num(p.id) != null) provMap.set(num(p.id)!, row.id);
      report.providers++;
    }

    for (const c of payload.savedCredentials ?? []) {
      if (c.data == null) {
        // Exported by an instance whose key could not read it. Restoring an empty secret
        // would look like a credential that exists and silently fails on use.
        report.skipped.push(`credential "${String(c.name)}" (could not be read at export time)`);
        continue;
      }
      const [row] = await tx
        .insert(savedCredentialsTable)
        .values({
          name: String(c.name ?? "credential"),
          username: String(c.username ?? ""),
          encryptedData: encrypt(JSON.stringify(c.data)),
        })
        .returning({ id: savedCredentialsTable.id });
      if (num(c.id) != null) credMap.set(num(c.id)!, row.id);
      report.savedCredentials++;
    }

    for (const t of payload.tasks ?? []) {
      // Ids live in three places on a task: its own columns, its browserConfig, and the
      // credentialId inside a login step. All three are rewritten.
      const bc = (t.browserConfig ?? null) as Row | null;
      const rewrittenConfig = bc
        ? {
            ...bc,
            ...(("fingerprintProfileId" in bc) ? { fingerprintProfileId: via(fMap, bc.fingerprintProfileId) } : {}),
            ...(("proxyProfileId" in bc) ? { proxyProfileId: via(pMap, bc.proxyProfileId) } : {}),
            ...(("providerId" in bc) ? { providerId: via(provMap, bc.providerId) } : {}),
          }
        : null;
      const steps = Array.isArray(t.steps)
        ? (t.steps as Row[]).map((s) =>
            "credentialId" in s ? { ...s, credentialId: via(credMap, s.credentialId) } : s,
          )
        : (t.steps ?? null);

      const [row] = await tx
        .insert(tasksTable)
        .values({
          name: String(t.name ?? "task"),
          targetUrl: String(t.targetUrl ?? "about:blank"),
          loginType: (t.loginType as string | null) ?? null,
          steps: steps as never,
          cronExpression: (t.cronExpression as string | null) ?? null,
          browserConfig: rewrittenConfig as never,
          retryCount: num(t.retryCount),
          retryIntervalMinutes: num(t.retryIntervalMinutes),
          webhookEnabled: false,
          fingerprintProfileId: via(fMap, t.fingerprintProfileId) as number | null,
          proxyProfileId: via(pMap, t.proxyProfileId) as number | null,
          groupId: via(gMap, t.groupId) as number | null,
          sortOrder: num(t.sortOrder),
          status: "idle",
          // Never enabled by a restore. See the note above the function.
          enabled: false,
        })
        .returning({ id: tasksTable.id });
      if (num(t.id) != null) taskMap.set(num(t.id)!, row.id);
      report.tasks++;
    }

    for (const c of payload.taskCredentials ?? []) {
      const taskId = taskMap.get(c.taskId);
      if (taskId == null || c.data == null) continue;
      await tx.insert(credentialsTable).values({ taskId, encryptedData: encrypt(JSON.stringify(c.data)) });
      report.taskCredentials++;
    }

    for (const s of payload.sessionProfiles ?? []) {
      if (s.state == null) {
        report.skipped.push(`browser "${String(s.name)}" (its saved session could not be read at export time)`);
        continue;
      }
      await tx.insert(sessionProfilesTable).values({
        name: String(s.name ?? "browser"),
        storageState: { enc: encrypt(JSON.stringify(s.state)) } as never,
        providerId: via(provMap, s.providerId) as number | null,
        fingerprintProfileId: via(fMap, s.fingerprintProfileId) as number | null,
        proxyProfileId: via(pMap, s.proxyProfileId) as number | null,
        originUrl: (s.originUrl as string | null) ?? null,
        openUrls: (s.openUrls ?? null) as never,
        // Same reason tasks arrive disabled: a restore should not start opening browsers.
        autostart: false,
      });
      report.sessionProfiles++;
    }

    for (const s of payload.browserSessions ?? []) {
      const taskId = taskMap.get(s.taskId);
      if (taskId == null || s.state == null) continue;
      await tx.insert(browserSessionsTable).values({
        taskId,
        sessionKey: s.sessionKey || "default",
        storageState: { enc: encrypt(JSON.stringify(s.state)) } as never,
      });
      report.browserSessions++;
    }

    for (const s of payload.settings ?? []) {
      if (!s?.key) continue;
      // Only where nothing is set. A restore must not silently retune an instance someone
      // has already configured.
      await tx
        .insert(settingsTable)
        .values({ key: s.key, value: String(s.value ?? "") })
        .onConflictDoNothing();
      report.settings++;
    }
  });

  logger.info({ ...report, skipped: report.skipped.length }, "Backup restored");
  return report;
}

/** Constant-time compare, for anywhere a passphrase is checked rather than used. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
