-- Execution Manager: one row per thing the product ran, including every tool
-- call Godfather makes. The table was already declared in db/schema.ts but had
-- never been created; this is additive only and touches no existing row.

CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  conversation_id text,
  panel_id text,
  automation_id text,
  status text NOT NULL DEFAULT 'queued',
  role text NOT NULL,
  model text,
  prompt text NOT NULL,
  result text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  approved_at timestamptz,
  approval_id uuid,
  tool_calls integer DEFAULT 0,
  tokens_used integer,
  neurons_used integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS executions_user_id_created_at_idx
  ON executions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS executions_conversation_id_idx
  ON executions (conversation_id);
