-- Role model preferences — additive only, safe to re-run.
--
-- One row per (person, role): the model that person chose to lead that role when
-- Godfather answers. Personal, unlike PARADOX_MODEL_* (which is the operator's
-- default for everyone).
--
-- The row stores only the identity. Everything else — capabilities, free tier,
-- position in the ladder — is read from the catalogue on every call, so a model
-- that is removed or loses a capability stops being used without a migration.
-- Deleting the row returns the role to the operator's default; no existing table
-- is touched.

create table if not exists "ai_model_preferences" (
  "user_id" text not null,
  "role" text not null,
  "provider" text not null,
  "model_id" text not null,
  "updated_at" timestamp with time zone not null default now(),
  constraint "ai_model_preferences_pk" primary key ("user_id", "role")
);
