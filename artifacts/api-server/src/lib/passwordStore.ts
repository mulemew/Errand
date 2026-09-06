import { scrypt, randomBytes, timingSafeEqual, createHash, type ScryptOptions } from "crypto";
  import { db, settingsTable, eq } from "@workspace/db";

  // promisify() picks the overload without options, so the cost parameters could not be
  // passed through it. Wrapped by hand instead.
  function scryptAsync(
    password: string,
    salt: string,
    keylen: number,
    options: ScryptOptions,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(password, salt, keylen, options, (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      });
    });
  }

  const PASSWORD_KEY = "passwordHash";

  /**
   * scrypt cost, stored WITH the hash.
   *
   * It was not stored, and that is the part that mattered: without the parameters a hash
   * can only ever be verified at whatever cost the code happens to use today, so raising
   * the cost later would invalidate every existing password. Recording them makes the cost
   * an upgradable property instead of a permanent decision.
   *
   * N=65536 is four times Node's default and needs 64 MB per hash (128·N·r), which is why
   * maxmem is raised too — the default 32 MB would make scrypt throw rather than run. The
   * memory is the point: it is what makes a stolen hash expensive to attack in parallel.
   * That much per attempt is only affordable because the login endpoint is rate limited.
   */
  const SCRYPT = { N: 65536, r: 8, p: 1, keylen: 64 } as const;

  /**
   * What a hash written before the parameters were stored was made with: Node's own
   * defaults. Every existing password is one of these, and must keep verifying.
   */
  const LEGACY = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

  type ScryptParams = { N: number; r: number; p: number; keylen: number };

  type PasswordStore = {
    hash: string;
    salt: string;
    /** Absent on anything written before this was recorded — see LEGACY. */
    params?: ScryptParams;
  };

  async function hashPassword(password: string, salt: string, params: ScryptParams): Promise<string> {
    const derivedKey = (await scryptAsync(password, salt, params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      // 128·N·r is what scrypt actually allocates; the headroom keeps Node from refusing.
      maxmem: 256 * params.N * params.r,
    })) as Buffer;
    return derivedKey.toString("hex");
  }

  async function loadStore(): Promise<PasswordStore | null> {
    const [row] = await db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, PASSWORD_KEY));
    if (!row) return null;
    try {
      return JSON.parse(row.value) as PasswordStore;
    } catch {
      return null;
    }
  }

  async function savePassword(password: string): Promise<void> {
    const salt = randomBytes(16).toString("hex");
    const hash = await hashPassword(password, salt, SCRYPT);
    const value = JSON.stringify({ hash, salt, params: SCRYPT });
    await db
      .insert(settingsTable)
      .values({ key: PASSWORD_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
  }

  export async function hasStoredPassword(): Promise<boolean> {
    const [row] = await db
      .select({ key: settingsTable.key })
      .from(settingsTable)
      .where(eq(settingsTable.key, PASSWORD_KEY));
    return !!row;
  }

  export async function verifyPassword(candidate: string): Promise<boolean> {
    const store = await loadStore();
    if (!store) {
      const envPassword = process.env.DASHBOARD_PASSWORD;
      if (!envPassword) return false;
      // #fix-timing — hash both sides to a fixed-length digest before comparing.
      // Previously a direct length check caused early return, leaking the password
      // length via response timing. SHA-256 normalises both to 32 bytes so
      // timingSafeEqual always runs in constant time regardless of input length.
      const a = createHash("sha256").update(candidate).digest();
      const b = createHash("sha256").update(envPassword).digest();
      return timingSafeEqual(a, b);
    }
    // Verified at the cost it was WRITTEN at, which for anything predating this change is
    // Node's defaults. Getting this wrong locks the user out of their own instance.
    const used: ScryptParams = store.params ?? LEGACY;
    const candidateHash = await hashPassword(candidate, store.salt, used);
    const storedHash = Buffer.from(store.hash, "hex");
    const candidateBuf = Buffer.from(candidateHash, "hex");
    if (storedHash.length !== candidateBuf.length) return false;
    const ok = timingSafeEqual(storedHash, candidateBuf);

    // A correct password stored at an older cost is re-hashed at the current one, here,
    // because this is the only moment the plaintext exists. Nobody has to be told to
    // change their password to get the stronger hash. Failure is not fatal: the login
    // already succeeded, and the next one will try again.
    if (ok && used.N < SCRYPT.N) {
      try {
        await savePassword(candidate);
      } catch { /* keep the working hash rather than fail a valid login */ }
    }
    return ok;
  }

  /** Set the initial password. Only intended for first-run setup. */
  export async function initPassword(password: string): Promise<{ ok: boolean; error?: string }> {
    if (!password || password.length < 8) {
      return { ok: false, error: "Password must be at least 8 characters" };
    }
    await savePassword(password);
    return { ok: true };
  }

  export async function changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: boolean; error?: string }> {
    const valid = await verifyPassword(currentPassword);
    if (!valid) {
      return { ok: false, error: "Current password is incorrect" };
    }
    if (!newPassword || newPassword.length < 8) {
      return { ok: false, error: "New password must be at least 8 characters" };
    }
    await savePassword(newPassword);
    return { ok: true };
  }
