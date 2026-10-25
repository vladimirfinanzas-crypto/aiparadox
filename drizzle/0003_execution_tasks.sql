-- Execution tasks: one row per piece of work Godfather runs somewhere other
-- than its own sandbox. The row exists before anything runs, because the person
-- may have to choose where the work happens ("awaiting_execution_environment").
--
--   node scripts/apply-migration.mjs drizzle/0003_execution_tasks.sql
--
-- Additive only: nothing else in the schema changes and no data is rewritten.

-- Jobs may now be addressed to one computer, so a task that opened its browser
-- window on a machine never continues on another.
ALTER TABLE "pc_jobs" ADD COLUMN IF NOT EXISTS "device_id" text;

CREATE TABLE IF NOT EXISTS "execution_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "conversation_id" text,
  "request" text NOT NULL,
  -- 'local' | 'cloud'; NULL while the person has not chosen
  "environment" text,
  "status" text DEFAULT 'awaiting_execution_environment' NOT NULL,
  "reason" text,
  "options" jsonb,
  "browser_session_id" text,
  "error" text,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "execution_tasks_user_id_idx"
  ON "execution_tasks" ("user_id");

CREATE INDEX IF NOT EXISTS "execution_tasks_conversation_idx"
  ON "execution_tasks" ("conversation_id", "status");

-- Finding the conversation's pending question is the hottest read of this
-- table: a turn that needs a browser looks it up before every tool call.
CREATE INDEX IF NOT EXISTS "execution_tasks_pending_idx"
  ON "execution_tasks" ("conversation_id")
  WHERE "status" = 'awaiting_execution_environment';
