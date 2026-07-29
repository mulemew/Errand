/**
 * stt.ts — speech-to-text for the reCAPTCHA audio-challenge solver.
 *
 * Transcription is backend-agnostic: whichever browser backend drove the
 * challenge, the downloaded audio is handed here to be turned into text.
 *
 * Engine order (configurable via RECAPTCHA_STT_ORDER, comma-separated):
 *   1. "whisper" — POST the audio to cf-proxy's /transcribe endpoint, which runs
 *                  faster-whisper LOCALLY. Free, no API key, no per-IP rate limit
 *                  and no risk of a future paywall. Default primary.
 *   2. "witai"   — Facebook/Meta wit.ai /speech API. Free tier, needs a server
 *                  token (WIT_AI_TOKEN). Reliable and fast when configured.
 *   3. "google"  — SpeechRecognition-style free Google endpoint. No key, but it
 *                  is an unofficial demo endpoint Google can throttle/kill at any
 *                  time. Last-resort fallback.
 *
 * All engines receive the raw audio bytes (reCAPTCHA serves MP3). wit.ai and the
 * whisper sidecar accept MP3 directly; the Google endpoint needs 16 kHz mono
 * FLAC, which cf-proxy's /transcribe can also produce — so for "google" we route
 * through cf-proxy too when available and otherwise skip (documented below).
 */
import { logger } from "../lib/logger";

const DEFAULT_CF_PROXY_URL = process.env.CF_PROXY_URL ?? "http://provider-seleniumbase:7317";

function engineOrder(): string[] {
  const raw = process.env.RECAPTCHA_STT_ORDER;
  if (raw && raw.trim()) {
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return ["whisper", "witai", "google"];
}

/** Normalise a raw transcript to the shape reCAPTCHA expects (lowercase words). */
function cleanTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── whisper (via cf-proxy local faster-whisper) ──────────────────────────────

/** One engine's outcome. `reason` is only set when it produced no text. */
export type SttAttempt = { engine: string; ms: number; reason?: string };
export type SttResult = { text: string | null; engine?: string; ms?: number; attempts: SttAttempt[] };
type EngineResult = { text: string | null; reason?: string };

/** Human-readable "who was tried and why each one gave up", for a task-log line. */
export function describeSttAttempts(attempts: SttAttempt[]): string {
  return attempts.map((a) => `${a.engine}: ${a.reason ?? "no text"} (${(a.ms / 1000).toFixed(1)}s)`).join("; ");
}

async function transcribeViaWhisper(audio: Buffer): Promise<EngineResult> {
  const url = `${DEFAULT_CF_PROXY_URL.replace(/\/$/, "")}/transcribe`;
  try {
    const controller = new AbortController();
    // The sidecar serialises transcription (one model, shared by every task), so this has
    // to cover a queue wait plus the decode itself — not just the decode.
    const timer = setTimeout(() => controller.abort(), 90_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        // Cast around the lib.dom `BodyInit` vs @types/node `Buffer<ArrayBufferLike>`
        // mismatch — Node's fetch accepts a Buffer body at runtime.
        body: audio as unknown as BodyInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
    if (!res.ok || data.error || typeof data.text !== "string") {
      return { text: null, reason: `HTTP ${res.status}${data.error ? ` — ${data.error}` : ""}` };
    }
    const cleaned = cleanTranscript(data.text);
    // An EMPTY transcript is not the same failure as an unreachable sidecar: whisper ran and
    // heard nothing, which usually means what we posted was not audio at all.
    return cleaned ? { text: cleaned } : { text: null, reason: "ran but transcript was empty" };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      text: null,
      reason: aborted
        ? "timed out after 90s (cf-proxy queue + decode)"
        : `cf-proxy unreachable: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

// ── wit.ai ───────────────────────────────────────────────────────────────────

async function transcribeViaWitAi(audio: Buffer): Promise<EngineResult> {
  const token = process.env.WIT_AI_TOKEN;
  if (!token) return { text: null, reason: "WIT_AI_TOKEN not set — skipped" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch("https://api.wit.ai/speech?v=20230215", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          // reCAPTCHA serves MPEG audio; wit.ai decodes it server-side.
          "Content-Type": "audio/mpeg3",
        },
        // Cast around the lib.dom `BodyInit` vs @types/node `Buffer<ArrayBufferLike>`
        // mismatch — Node's fetch accepts a Buffer body at runtime.
        body: audio as unknown as BodyInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    // wit.ai streams multiple JSON objects; the final one carries the full text.
    const body = await res.text();
    if (!res.ok) return { text: null, reason: `HTTP ${res.status}` };
    // Grab the last "text" field in the (possibly chunked) response.
    const matches = [...body.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    const last = matches.length ? matches[matches.length - 1][1] : "";
    const cleaned = cleanTranscript(last.replace(/\\"/g, '"'));
    return cleaned ? { text: cleaned } : { text: null, reason: "ran but transcript was empty" };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { text: null, reason: aborted ? "timed out after 30s" : `${(err as Error)?.message ?? String(err)}` };
  }
}

// ── google (unofficial free endpoint, via cf-proxy FLAC conversion) ──────────

async function transcribeViaGoogle(audio: Buffer): Promise<EngineResult> {
  // The free Google speech endpoint needs 16 kHz mono FLAC. Rather than pull a
  // second audio toolchain into the Node container, ask cf-proxy to do the
  // conversion + recognition (it has ffmpeg + SpeechRecognition). If cf-proxy is
  // not reachable this simply returns null and the chain ends.
  const url = `${DEFAULT_CF_PROXY_URL.replace(/\/$/, "")}/transcribe?engine=google`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        // Cast around the lib.dom `BodyInit` vs @types/node `Buffer<ArrayBufferLike>`
        // mismatch — Node's fetch accepts a Buffer body at runtime.
        body: audio as unknown as BodyInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || data.error || typeof data.text !== "string") {
      return { text: null, reason: `HTTP ${res.status}${data.error ? ` — ${data.error}` : ""}` };
    }
    const cleaned = cleanTranscript(data.text);
    return cleaned ? { text: cleaned } : { text: null, reason: "ran but transcript was empty" };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      text: null,
      reason: aborted ? "timed out after 45s" : `cf-proxy unreachable: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

/**
 * Transcribe reCAPTCHA audio to text, trying each configured engine in order until one
 * returns a non-empty result.
 *
 * Returns WHICH engine answered and, on failure, what every engine said. This used to be a
 * bare `string | null` with each engine's reason logged at debug and then dropped, so the
 * task log could only ever say "no STT engine returned text" — identical output whether the
 * sidecar was busy, the model was missing, the clip was not audio, or wit.ai had no token.
 * Four different fixes, one indistinguishable message.
 */
export async function transcribeAudio(audio: Buffer): Promise<SttResult> {
  const attempts: SttAttempt[] = [];
  for (const engine of engineOrder()) {
    const started = Date.now();
    let out: EngineResult;
    if (engine === "whisper") out = await transcribeViaWhisper(audio);
    else if (engine === "witai") out = await transcribeViaWitAi(audio);
    else if (engine === "google") out = await transcribeViaGoogle(audio);
    else {
      logger.warn({ engine }, "Unknown STT engine in RECAPTCHA_STT_ORDER — skipping");
      attempts.push({ engine, ms: 0, reason: "unknown engine" });
      continue;
    }
    const ms = Date.now() - started;
    if (out.text) {
      logger.info({ engine, ms, chars: out.text.length }, "reCAPTCHA audio transcribed");
      attempts.push({ engine, ms });
      return { text: out.text, engine, ms, attempts };
    }
    // WARN, not debug: this is the only place the actual cause exists.
    logger.warn({ engine, ms, reason: out.reason }, "STT engine returned no text — trying next");
    attempts.push({ engine, ms, reason: out.reason });
  }
  return { text: null, attempts };
}
