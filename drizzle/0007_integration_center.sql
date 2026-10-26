-- Integration centre — additive only, safe to re-run.
--
-- Three per-user tables, each scoped by user_id (Clerk id):
--
--   ai_provider_settings  which AI providers this person enabled and in what
--                         order. Read once per chat turn and handed to the same
--                         router that reads PARADOX_PROVIDER_ORDER, so there is
--                         one selection/fallback system, not two.
--   custom_integrations   an API the person added themselves. The credential is
--                         stored encrypted (AES-256-GCM, lib/secrets.ts) and
--                         only a masked hint is kept in clear text.
--   mcp_servers           an MCP endpoint the person added. Stored, validated
--                         and probed; tool discovery is reported honestly, so a
--                         saved URL is never shown as a working connection.
--
-- No existing table is touched, nothing is dropped, and a person with no rows
-- keeps the behaviour they had (the environment's defaults).

create table if not exists "ai_provider_settings" (
  "user_id" text not null,
  "provider" text not null,
  "enabled" boolean not null default true,
  -- Lower wins. Rows are written as a whole ordered list by the server action.
  "position" integer not null default 0,
  "updated_at" timestamp with time zone not null default now(),
  constraint "ai_provider_settings_pk" primary key ("user_id", "provider")
);

-- `provider` is one of lib/ai/types.ts PROVIDER_IDS. The check is intentionally
-- absent: adding a provider should not need a migration.

create table if not exists "custom_integrations" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" text not null,
  "name" text not null,
  "category" text not null default 'other',
  "base_url" text not null,
  "auth_type" text not null default 'bearer',
  -- AES-256-GCM: iv.tag.ciphertext, base64. Never selected into a client payload.
  "credential_ciphertext" text,
  -- Last four characters, so a person can recognise which key is stored.
  "credential_hint" text,
  "description" text,
  "capabilities" jsonb not null default '[]'::jsonb,
  -- 'configured' (fields saved) | 'verified' (a real request succeeded) | 'error'
  "status" text not null default 'configured',
  "last_checked_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);

create index if not exists "custom_integrations_user_idx"
  on "custom_integrations" ("user_id", "created_at" desc);

create table if not exists "mcp_servers" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" text not null,
  "name" text not null,
  -- 'http' (streamable HTTP JSON-RPC) only: this app runs in the cloud and never
  -- executes a local command for a person.
  "transport" text not null default 'http',
  "url" text not null,
  "auth_type" text not null default 'none',
  "credential_ciphertext" text,
  "credential_hint" text,
  "enabled" boolean not null default true,
  -- Tools the server itself listed, as returned by tools/list.
  "tools" jsonb not null default '[]'::jsonb,
  "status" text not null default 'unverified',
  "last_checked_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);

create index if not exists "mcp_servers_user_idx"
  on "mcp_servers" ("user_id", "created_at" desc);
