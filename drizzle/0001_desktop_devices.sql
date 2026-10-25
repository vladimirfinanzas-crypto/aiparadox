-- Desktop Agent devices and enrollment sessions.
-- Additive only: no existing table or row is touched.

CREATE TABLE IF NOT EXISTS desktop_devices (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  os text,
  agent_version text,
  -- SHA-256 of the bearer token; the token itself is never stored
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'online',
  capabilities jsonb NOT NULL DEFAULT '["screen","mouse","keyboard"]'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS desktop_devices_user_id_idx
  ON desktop_devices (user_id);

CREATE TABLE IF NOT EXISTS desktop_enrollments (
  code text PRIMARY KEY,
  user_id text,
  device_name text,
  os text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS desktop_enrollments_status_idx
  ON desktop_enrollments (status);
