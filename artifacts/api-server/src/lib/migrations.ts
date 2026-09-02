import { pool } from "@workspace/db";
  import { logger } from "./logger";

  const SQL = `
  CREATE TABLE IF NOT EXISTS "tasks" (
    "id"              serial      PRIMARY KEY,
    "name"            text        NOT NULL,
    "target_url"      text        NOT NULL,
    "login_type"      text        NOT NULL DEFAULT 'form',
    "steps"           jsonb,
    "cron_expression" text,
    "status"          text        NOT NULL DEFAULT 'idle',
    "last_run_at"     timestamptz,
    "created_at"      timestamptz NOT NULL DEFAULT now(),
    "updated_at"      timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "credentials" (
    "id"             serial  PRIMARY KEY,
    "task_id"        integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
    "encrypted_data" text    NOT NULL,
    "created_at"     timestamptz NOT NULL DEFAULT now(),
    "updated_at"     timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "logs" (
    "id"              serial  PRIMARY KEY,
    "task_id"         integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
    "run_at"          timestamptz NOT NULL DEFAULT now(),
    "success"         boolean NOT NULL DEFAULT false,
    "message"         text    NOT NULL DEFAULT '',
    "screenshot_path" text,
    "duration_ms"     integer,
    "created_at"      timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true;
    ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "next_run_at" timestamptz;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "login_type" text;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "triggered_by" text;
  ALTER TABLE "logs"  ADD COLUMN IF NOT EXISTS "triggered_by" text;
  ALTER TABLE "logs"  ADD COLUMN IF NOT EXISTS "duration_ms"  integer;
  ALTER TABLE "logs"  ADD COLUMN IF NOT EXISTS "step_logs"    jsonb;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "browser_config" jsonb;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "exit_geo" jsonb;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "retry_count" integer;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "retry_interval_minutes" integer;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "retry_attempt" integer NOT NULL DEFAULT 0;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "webhook_enabled" boolean NOT NULL DEFAULT false;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "webhook_token" text;
    CREATE TABLE IF NOT EXISTS "sessions" (
    "token"      text        PRIMARY KEY,
    "expires_at" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "settings" (
    "key"        text PRIMARY KEY,
    "value"      text        NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "saved_credentials" (
    "id"             serial      PRIMARY KEY,
    "name"           text        NOT NULL,
    "username"       text        NOT NULL,
    "encrypted_data" text        NOT NULL,
    "created_at"     timestamptz NOT NULL DEFAULT now(),
    "updated_at"     timestamptz NOT NULL DEFAULT now()
  );
  -- Moved down from among the tasks/logs ALTERs, where it ran BEFORE the table above
  -- existed. ADD COLUMN IF NOT EXISTS guards the COLUMN, not the TABLE, so on an empty
  -- database this raised 'relation "saved_credentials" does not exist' — and because the
  -- whole script goes to the server as ONE multi-statement query, Postgres wrapped it in an
  -- implicit transaction and rolled back every table created before it. A fresh
  -- 'docker compose up -d' therefore came up with an empty schema and a server that would
  -- not start; every existing deployment was fine only because its tables already existed.
  --
  -- The invariant this file lives by: a table's ALTERs go directly after its CREATE. Nothing
  -- enforces it, so it is written down here.
  ALTER TABLE "saved_credentials" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
  CREATE TABLE IF NOT EXISTS "browser_sessions" (
    "id"            serial      PRIMARY KEY,
    "task_id"       integer     NOT NULL,
    "session_key"   text        NOT NULL DEFAULT 'default',
    "storage_state" jsonb       NOT NULL,
    "created_at"    timestamptz NOT NULL DEFAULT now(),
    "updated_at"    timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "browser_sessions_task_key_unique" ON "browser_sessions" ("task_id", "session_key");
  CREATE TABLE IF NOT EXISTS "fingerprint_profiles" (
    "id"         serial      PRIMARY KEY,
    "name"       text        NOT NULL,
    "os"         text        NOT NULL,
    "config"     jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "proxy_profiles" (
    "id"         serial      PRIMARY KEY,
    "name"       text        NOT NULL,
    "url"        text        NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "fingerprint_profile_id" integer;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "proxy_profile_id" integer;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "retry_at" timestamptz;
  ALTER TABLE "proxy_profiles" ADD COLUMN IF NOT EXISTS "exit_geo" jsonb;
  ALTER TABLE "proxy_profiles" ADD COLUMN IF NOT EXISTS "geo_updated_at" timestamptz;
  DROP TABLE IF EXISTS "provider_instances";
  CREATE TABLE IF NOT EXISTS "providers" (
    "id"              serial      PRIMARY KEY,
    "name"            text        NOT NULL,
    "type"            text        NOT NULL,
    "url"             text        NOT NULL DEFAULT '',
    "concurrency"     integer     NOT NULL DEFAULT 1,
    "enabled"         boolean     NOT NULL DEFAULT true,
    "healthy"         boolean,
    "last_error"      text,
    "last_checked_at" timestamptz,
    "created_at"      timestamptz NOT NULL DEFAULT now(),
    "updated_at"      timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "stealth" boolean;
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "block_ads" boolean;
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "ignore_https" boolean;
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "session_timeout_ms" integer;
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "viewport_width" integer;
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "viewport_height" integer;
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "humanize" boolean;
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "block_webrtc" boolean;
  -- The default backend now lives on a provider (the Settings browser-backend section is
  -- gone). At most one row may carry it; a partial unique index enforces that in the DB.
  ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false;
  CREATE UNIQUE INDEX IF NOT EXISTS "providers_single_default" ON "providers" ("is_default") WHERE "is_default";
  -- Dashboard grouping + manual ordering. No foreign key on purpose: a group is a view
  -- convenience and deleting one must never be able to take tasks with it.
  CREATE TABLE IF NOT EXISTS "task_groups" (
    "id"         serial      PRIMARY KEY,
    "name"       text        NOT NULL,
    "sort_order" integer     NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "group_id" integer;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sort_order" integer;

  CREATE TABLE IF NOT EXISTS "session_profiles" (
    "id"                     serial      PRIMARY KEY,
    "name"                   text        NOT NULL,
    "storage_state"          jsonb       NOT NULL,
    "provider_id"            integer,
    "fingerprint_profile_id" integer,
    "proxy_profile_id"       integer,
    "origin_url"             text,
    "created_at"             timestamptz NOT NULL DEFAULT now(),
    "updated_at"             timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE "session_profiles" ADD COLUMN IF NOT EXISTS "autostart" boolean NOT NULL DEFAULT false;
  `;

  export async function runMigrations(): Promise<void> {
    logger.info("Running database migrations...");
    const client = await pool.connect();
    try {
      await client.query(SQL);
      logger.info("Database migrations complete.");
    } finally {
      client.release();
    }
  }
 