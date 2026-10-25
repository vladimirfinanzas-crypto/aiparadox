// A flow that needs the person's computer, run while no device is listening.
// It must fail with an actionable message and never be reported as done.

import { Client } from "pg"

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file)
  } catch {}
}

const { configure, tasks } = await import("@trigger.dev/sdk")
configure({ accessToken: process.env.TRIGGER_SECRET_KEY })

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const USER = "__e2e_desktop__"
await client.query("delete from workflows where user_id = $1", [USER])

const definition = {
  schemaVersion: 2,
  name: "E2E · escritorio desconectado",
  trigger: { kind: "manual", timezone: "Europe/Madrid" },
  nodes: [
    { id: "start", type: "start", kind: "trigger", title: "Start", config: {}, position: { x: 0, y: 0 } },
    {
      id: "shot",
      type: "desktop-action",
      kind: "action",
      title: "Captura de pantalla",
      config: { action: "screenshot" },
      position: { x: 260, y: 0 },
    },
  ],
  edges: [{ id: "e1", source: "start", target: "shot" }],
  settings: { onError: "stop", retries: 0, maxSteps: 40, timeoutMs: 900000 },
}

const { rows } = await client.query(
  `insert into workflows (user_id, name, definition, version, status, execution_target, timezone)
   values ($1, $2, $3, 1, 'draft', 'local', 'Europe/Madrid') returning id`,
  [USER, definition.name, JSON.stringify(definition)]
)
const workflowId = rows[0].id

await client.query(
  `insert into automation_versions (workflow_id, user_id, version, definition, author, summary)
   values ($1, $2, 1, $3, 'user', 'E2E desktop')`,
  [workflowId, USER, JSON.stringify(definition)]
)

const run = await client.query(
  `insert into automation_runs (workflow_id, user_id, version, status, origin, environment, idempotency_key)
   values ($1, $2, 1, 'queued', 'manual', 'local', $3) returning id`,
  [workflowId, USER, `e2e-desktop:${Date.now()}`]
)
const runId = run.rows[0].id

const handle = await tasks.trigger("run-automation", { runId })
await client.query("update automation_runs set trigger_run_id = $2 where id = $1", [runId, handle.id])

for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const { rows: current } = await client.query(
    `select status, error from automation_runs where id = $1`,
    [runId]
  )
  if (["succeeded", "failed", "cancelled", "blocked"].includes(current[0].status)) {
    console.log("RESULT", JSON.stringify(current[0]))
    const { rows: steps } = await client.query(
      `select node_id, status, error from automation_run_steps where run_id = $1`,
      [runId]
    )
    console.table(steps)
    await client.end()
    // The point of the test: it must NOT have succeeded.
    process.exit(current[0].status === "failed" ? 0 : 1)
  }
}

console.error("TIMEOUT")
await client.end()
process.exit(1)
