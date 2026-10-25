// Applies a SQL file in drizzle/ to the database, once. The project already
// ships drizzle-kit for generated migrations; this runner is for the additive
// desktop-device migration that a review can read as plain SQL.
//
//   node scripts/apply-migration.mjs drizzle/0001_desktop_devices.sql
//
// It uses the direct (non-pooled) connection because DDL needs a session.

import { readFile } from "node:fs/promises"
import process from "node:process"
import { Client } from "pg"

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file)
  } catch {
    // A missing file is fine: the value may come from the shell
  }
}

const path = process.argv[2]
if (!path) {
  console.error("Usage: node scripts/apply-migration.mjs <file.sql>")
  process.exit(1)
}

const raw = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
if (!raw) {
  console.error("Neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set.")
  process.exit(1)
}

const url = new URL(raw)
const sslmode = url.searchParams.get("sslmode")
if (sslmode && sslmode !== "verify-full") {
  url.searchParams.set("sslmode", "verify-full")
}

const sql = await readFile(path, "utf8")
const client = new Client({ connectionString: url.toString() })

await client.connect()
try {
  await client.query(sql)
  console.log(`Applied ${path}`)
} finally {
  await client.end()
}
