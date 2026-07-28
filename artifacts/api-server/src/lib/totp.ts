import crypto from "crypto";

/**
 * Clean up a TOTP secret as a human actually pastes it.
 *
 * Google (and most issuers) display the secret in groups of four — "abcd efgh ijkl mnop" —
 * and that is what ends up in the field. Base32 decoders reject the spaces: otplib throws
 * `Invalid Base32 string: Unknown letter: " "`, which surfaced as a login failure with no
 * hint that the stored secret was the problem. An otpauth:// URI is just as common a paste,
 * so it is unwrapped here too.
 *
 * Returns "" when nothing usable is left, which the caller should treat as "no secret".
 */
export function normalizeTotpSecret(raw: string | null | undefined): string {
  if (!raw) return "";
  let value = String(raw).trim();

  // A whole otpauth:// URI — take its secret parameter.
  if (/^otpauth:\/\//i.test(value)) {
    try {
      const secret = new URL(value).searchParams.get("secret");
      if (secret) value = secret;
    } catch {
      const m = /[?&]secret=([^&]+)/i.exec(value);
      if (m) value = decodeURIComponent(m[1]);
    }
  }

  // Base32 is case-insensitive; spaces, dashes and "=" padding are presentation only.
  return value.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

/** Decode base32 (RFC 4648, no padding). Assumes an already-normalised string. */
function decodeBase32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const byteCount = Math.floor(bits.length / 8);
  const bytes = Buffer.alloc(byteCount);
  for (let i = 0; i < byteCount; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

/** Is this something we can actually generate codes from? */
export function isUsableTotpSecret(raw: string | null | undefined): boolean {
  const s = normalizeTotpSecret(raw);
  // 16 base32 chars = 80 bits, the shortest secret any common issuer hands out.
  return s.length >= 16 && decodeBase32(s).length > 0;
}

/**
 * Current TOTP code. Normalises first, so a secret stored before this existed (spaces and
 * all) still works without anyone having to re-enter it.
 */
export function generateTotpCode(rawSecret: string, digits = 6, period = 30): string {
  const secret = normalizeTotpSecret(rawSecret);
  if (!secret) throw new Error("TOTP secret is empty after normalisation — check the stored value");
  const key = decodeBase32(secret);
  if (key.length === 0) throw new Error("TOTP secret is not valid base32 — check the stored value");

  const counter = Math.floor(Date.now() / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}
