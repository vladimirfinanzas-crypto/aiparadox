-- A step belongs to one node of one run. The runner upserts on this key, so a
-- retried flush (or a task resume) rewrites the step instead of appending a
-- second row for the same block.
create unique index if not exists "automation_run_steps_run_node_unique"
  on "automation_run_steps" ("run_id", "node_id");
