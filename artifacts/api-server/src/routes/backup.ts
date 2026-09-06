/**
 * Whole-instance backup and restore.
 *
 * Two endpoints, both POST, both taking a passphrase in the body — never in the URL, where
 * it would sit in access logs and browser history.
 *
 * The file never touches this server's disk. Export builds it in memory and streams it as a
 * download; import reads it out of the request. There is no path where a decrypted backup
 * exists as a file anyone could later find.
 */
import { Router, type IRouter } from "express";
import { collect, seal, open, restore } from "../lib/backup";

const router: IRouter = Router();

/** Long enough that the KDF is not the weak part. Short enough that people use it. */
const MIN_PASSPHRASE = 8;

router.post("/backup/export", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { passphrase?: string; includeSessions?: boolean };
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  if (passphrase.length < MIN_PASSPHRASE) {
    res.status(400).json({ error: `The passphrase must be at least ${MIN_PASSPHRASE} characters.` });
    return;
  }
  try {
    const payload = await collect({ includeSessions: body.includeSessions !== false });
    const file = await seal(payload, passphrase);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="errand-backup-${stamp}.json"`);
    // A backup is the one thing that must never be served from a cache.
    res.setHeader("Cache-Control", "no-store");
    req.log?.info(
      {
        tasks: payload.tasks.length,
        credentials: payload.savedCredentials.length,
        sessions: payload.sessionProfiles.length,
      },
      "Backup exported",
    );
    res.json(file);
  } catch (err) {
    req.log?.error({ err }, "Backup export failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/backup/import", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { passphrase?: string; file?: unknown };
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  if (!passphrase || !body.file) {
    res.status(400).json({ error: "A backup file and its passphrase are both required." });
    return;
  }
  let payload;
  try {
    payload = await open(body.file, passphrase);
  } catch (err) {
    // Wrong passphrase and wrong file are different problems with different fixes, and
    // open() has already told them apart.
    res.status(400).json({ error: err instanceof Error ? err.message : "This backup could not be opened." });
    return;
  }
  try {
    const report = await restore(payload);
    res.status(201).json({ ok: true, ...report });
  } catch (err) {
    req.log?.error({ err }, "Backup restore failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      hint: "Nothing was written — the whole restore runs in one transaction and rolled back.",
    });
  }
});

export default router;
