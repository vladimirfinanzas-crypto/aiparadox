-- Automations v2 — additive only. Nothing here drops or rewrites existing data:
-- the legacy `graph` column stays until the new definition has been verified,
-- and every new column is nullable or has a default so the running app keeps
-- working while the code is deployed.

alter table "workflows"
  add column if not exists "description" text,
  add column if not exists "status" text not null default 'draft',
  add column if not exists "definition" jsonb,
  add column if not exists "version" integer not null default 1,
  add column if not exists "execution_target" text not null default 'cloud',
  add column if not exists "timezone" text not null default 'UTC',
  add column if not exists "next_run_at" timestamp with time zone,
  add column if not exists "last_run_at" timestamp with time zone,
  add column if not exists "activated_at" timestamp with time zone;

alter table "workflows"
  drop constraint if exists "workflows_status_check";
alter table "workflows"
  add constraint "workflows_status_check"
  check ("status" in ('draft', 'pending_approval', 'active', 'paused', 'error'));

alter table "workflows"
  drop constraint if exists "workflows_execution_target_check";
alter table "workflows"
  add constraint "workflows_execution_target_check"
  check ("execution_target" in ('cloud', 'local', 'hybrid'));

create index if not exists "workflows_user_updated_idx"
  on "workflows" ("user_id", "updated_at" desc);
create index if not exists "workflows_status_next_run_idx"
  on "workflows" ("status", "next_run_at");

-- ---------------------------------------------------------------------------
-- Versions — the definition that actually ran, frozen. A run points at a
-- version number, never at the live row, so editing afterwards cannot rewrite
-- history.
-- ---------------------------------------------------------------------------
create table if not exists "automation_versions" (
  "id" uuid primary key default gen_random_uuid(),
  "workflow_id" uuid not null references "workflows"("id") on delete cascade,
  "user_id" text not null,
  "version" integer not null,
  "definition" jsonb not null,
  "author" text not null default 'user',
  "summary" text,
  "created_at" timestamp with time zone not null default now(),
  constraint "automation_versions_author_check" check ("author" in ('user', 'godfather', 'migration')),
  constraint "automation_versions_unique" unique ("workflow_id", "version")
);

create index if not exists "automation_versions_workflow_idx"
  on "automation_versions" ("workflow_id", "version" desc);

-- ---------------------------------------------------------------------------
-- Runs — one row per execution. The database is the source of truth for the
-- history; Trigger.dev only provides the live progress of the run in flight.
-- ---------------------------------------------------------------------------
create table if not exists "automation_runs" (
  "id" uuid primary key default gen_random_uuid(),
  "workflow_id" uuid not null references "workflows"("id") on delete cascade,
  "user_id" text not null,
  "version" integer not null default 1,
  "status" text not null default 'queued',
  "origin" text not null default 'manual',
  "environment" text not null default 'cloud',
  "trigger_run_id" text,
  "idempotency_key" text,
  "error" text,
  "output" jsonb,
  "started_at" timestamp with time zone not null default now(),
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  constraint "automation_runs_status_check"
    check ("status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked')),
  constraint "automation_runs_origin_check"
    check ("origin" in ('manual', 'schedule', 'godfather', 'api')),
  constraint "automation_runs_environment_check"
    check ("environment" in ('cloud', 'local', 'hybrid'))
);

create unique index if not exists "automation_runs_trigger_run_unique"
  on "automation_runs" ("trigger_run_id") where "trigger_run_id" is not null;
create unique index if not exists "automation_runs_idempotency_unique"
  on "automation_runs" ("idempotency_key") where "idempotency_key" is not null;
create index if not exists "automation_runs_workflow_idx"
  on "automation_runs" ("workflow_id", "started_at" desc);
create index if not exists "automation_runs_user_idx"
  on "automation_runs" ("user_id", "started_at" desc);
create index if not exists "automation_runs_status_idx"
  on "automation_runs" ("status");

-- ---------------------------------------------------------------------------
-- Run steps — what each block did, how long it took, what it produced.
-- Outputs are truncated before they are written; no secrets are stored.
-- ---------------------------------------------------------------------------
create table if not exists "automation_run_steps" (
  "id" uuid primary key default gen_random_uuid(),
  "run_id" uuid not null references "automation_runs"("id") on delete cascade,
  "node_id" text not null,
  "node_type" text not null,
  "title" text not null,
  "status" text not null default 'pending',
  "attempt" integer not null default 1,
  "error" text,
  "output" jsonb,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  constraint "automation_run_steps_status_check"
    check ("status" in ('pending', 'running', 'done', 'failed', 'skipped'))
);

create index if not exists "automation_run_steps_run_idx"
  on "automation_run_steps" ("run_id", "started_at");

-- ---------------------------------------------------------------------------
-- Schedules — the mapping to the durable scheduler. The cron itself lives in
-- one place only (Trigger.dev); this row keeps the id, the next run and the
-- enabled flag the UI reads without calling the API.
-- ---------------------------------------------------------------------------
create table if not exists "automation_schedules" (
  "id" uuid primary key default gen_random_uuid(),
  "workflow_id" uuid not null references "workflows"("id") on delete cascade,
  "user_id" text not null,
  "kind" text not null,
  "cron" text,
  "timezone" text not null default 'UTC',
  "enabled" boolean not null default true,
  "next_run_at" timestamp with time zone,
  "trigger_schedule_id" text,
  "updated_at" timestamp with time zone not null default now(),
  constraint "automation_schedules_kind_check" check ("kind" in ('cron', 'once')),
  constraint "automation_schedules_workflow_unique" unique ("workflow_id")
);

create index if not exists "automation_schedules_next_run_idx"
  on "automation_schedules" ("enabled", "next_run_at");

-- ---------------------------------------------------------------------------
-- Approvals — evidence that the person reviewed this exact version before it
-- was allowed to run on its own. `scope_hash` covers the consequential parts of
-- the definition, so any relevant edit invalidates the approval.
-- ---------------------------------------------------------------------------
create table if not exists "automation_approvals" (
  "id" uuid primary key default gen_random_uuid(),
  "workflow_id" uuid not null references "workflows"("id") on delete cascade,
  "user_id" text not null,
  "version" integer not null,
  "scope_hash" text not null,
  "actions" jsonb not null default '[]'::jsonb,
  "granted_at" timestamp with time zone not null default now(),
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);

create index if not exists "automation_approvals_workflow_idx"
  on "automation_approvals" ("workflow_id", "version" desc);
