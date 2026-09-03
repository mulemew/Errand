import { pgTable, text, serial, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A named, reusable logged-in session — cookies + localStorage — captured by hand.
 *
 * browser_sessions holds what a TASK saved for itself after logging in. This holds what YOU
 * saved from a browser you drove yourself: register an account, pass a challenge a script
 * cannot, and keep the resulting session as a profile a login step can simply select.
 *
 * The environment it was captured in is recorded alongside it, because a session is only
 * portable into a run that looks the same: same backend, same fingerprint, same exit IP.
 * The UI uses these to warn when a task picks a profile captured somewhere else.
 */
export const sessionProfilesTable = pgTable("session_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** Playwright storageState shape, encrypted at rest: { enc: "..." } */
  storageState: jsonb("storage_state").notNull(),
  /** The environment this session was captured in (all nullable — a profile is still
   *  usable without them, it just cannot be checked for a mismatch). */
  providerId: integer("provider_id"),
  fingerprintProfileId: integer("fingerprint_profile_id"),
  proxyProfileId: integer("proxy_profile_id"),
  /** Where it was captured, and where it was left — updated on every close. */
  originUrl: text("origin_url"),
  /** Where YOU want it to open. Set: always opens here. Empty: resumes from originUrl. */
  startUrl: text("start_url"),
  /** Every tab that was open at close, so reopening restores the whole window. */
  openUrls: jsonb("open_urls"),
  /** Open this browser again on startup. Off by default: each one is a whole Firefox. */
  autostart: boolean("autostart").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSessionProfileSchema = createInsertSchema(sessionProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSessionProfile = z.infer<typeof insertSessionProfileSchema>;
export type SessionProfile = typeof sessionProfilesTable.$inferSelect;
