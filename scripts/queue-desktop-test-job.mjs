// Test helper: queue one desktop action for whichever account has an online
// device. Exercises the local agent's job round-trip without going through a
// Godfather turn (which needs the Trigger.dev worker running).
//
//   node scripts/queue-desktop-test-job.mjs '{"kind":"run","command":"notepad"}'

import process from "node:process"
import { Client } from "pg"

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file)
  } catch {}
}

const raw = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
const url = new URL(raw)
if (url.searchParams.get("sslmode") !== "verify-full") {
  url.searchParams.set("sslmode", "verify-full")
}

const action = JSON.parse(process.argv[2] ?? '{"kind":"run","command":"notepad"}')
const client = new Client({ connectionString: url.toString() })
await client.connect()

// The account that has a device enrolled
const { rows } = await client.query(
  "select user_id from desktop_devices where status = 'online' order by last_seen_at desc limit 1"
)
if (!rows[0]) {
  console.error("no online device")
  process.exit(1)
}

const id = `test_${Date.now()}`
await client.query(
  "insert into pc_jobs (id, user_id, action, status) values ($1, $2, $3, 'pending')",
  [id, rows[0].user_id, JSON.stringify(action)]
)
console.log("queued", id)
await client.end()
