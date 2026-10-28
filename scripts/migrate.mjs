// Reproducible runner for the SQL migrations in drizzle/.
//
//   node scripts/migrate.mjs            apply every pending file, in order
//   node scripts/migrate.mjs --status   what is applied, what is pending
//   node scripts/migrate.mjs --mark <file.sql> [more.sql]
//                                        record a file as already applied,
//                                        WITHOUT running it (baseline only)
//
// Why this exists instead of `npm run db:migrate` (drizzle-kit):
//
//   * The journal (drizzle/meta/_journal.json) only knows 0000 and
//     0001_futuristic_gideon. Files 0001_desktop_devices … 0008 were added by
//     hand and are not in it, so drizzle-kit would silently skip them.
//   * The two 0001 files both create desktop_devices / desktop_enrollments.
//     0001_futuristic_gideon is the only file in the repo that does NOT use
//     `if not exists`, so it must run BEFORE 0001_desktop_devices. A plain
//     `for f in drizzle/*.sql` loop applies them in the opposite (alphabetical)
//     order and fails with 42P07 on a fresh database.
//
// Order used here: journal entries first (their recorded order), then every
// other file alphabetically. That is the order verified against a fresh
// database, including a second run.
//
// Each file runs in its own transaction (Postgres wraps a multi-statement
// query in one implicit transaction), so a failure rolls that file back and
// leaves nothing half-applied. Already-applied files are skipped via the
// ledger table, never re-executed.
//
// Nothing here drops, rewrites or regenerates history. On a database that was
// migrated by hand, run --status first: it reports, file by file, which of the
// objects each migration creates already exist, so the baseline can be recorded
// deliberately instead of guessed.

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { Client } from "pg"

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file)
  } catch {
    // A missing file is fine: the value may come from the shell
  }
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS paradox_migrations (
  tag text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`

function connectionUrl() {
  const raw = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
  if (!raw) {
    console.error(
      "Neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set. Point them at the database to inspect or migrate."
    )
    process.exit(1)
  }
  const url = new URL(raw)
  const sslmode = url.searchParams.get("sslmode")
  if (sslmode && sslmode !== "verify-full") {
    url.searchParams.set("sslmode", "verify-full")
  }
  return url.toString()
}

/** Journal order first, then everything else alphabetically. */
async function migrationOrder() {
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"))
  const journalTags = journal.entries.map((entry) => entry.tag)
  const onDisk = (await readdir("drizzle"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))

  const ordered = [
    ...journalTags.filter((tag) => onDisk.includes(tag)),
    ...onDisk.filter((tag) => !journalTags.includes(tag)),
  ]
  return ordered.map((tag) => ({ tag, file: `drizzle/${tag}.sql`, inJournal: journalTags.includes(tag) }))
}

/** Table names a migration creates — the evidence used to spot a baseline. */
async function createdTables(sql) {
  const names = []
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?([a-zA-Z0-9_]+)/gi
  for (const match of sql.matchAll(pattern)) names.push(match[1].toLowerCase())
  return [...new Set(names)]
}

const args = process.argv.slice(2)
const wantsStatus = args.includes("--status")
const markIndex = args.indexOf("--mark")
const toMark = markIndex === -1 ? [] : args.slice(markIndex + 1)

const client = new Client({ connectionString: connectionUrl() })
await client.connect()

try {
  await client.query(LEDGER_DDL)

  const applied = new Set(
    (await client.query("SELECT tag FROM paradox_migrations")).rows.map((row) => row.tag)
  )
  const order = await migrationOrder()

  if (markIndex !== -1) {
    for (const raw of toMark) {
      const tag = path.basename(raw).replace(/\.sql$/, "")
      if (!order.some((entry) => entry.tag === tag)) {
        console.error(`Unknown migration: ${raw}`)
        process.exitCode = 1
        continue
      }
      await client.query(
        `INSERT INTO paradox_migrations (tag, checksum) VALUES ($1, $2)
         ON CONFLICT (tag) DO NOTHING`,
        [tag, "marked"]
      )
      console.log(`marked applied: ${tag}`)
    }
    // Marking is a deliberate baseline decision, never followed by a run in the
    // same invocation: the operator re-runs the runner once they have seen the
    // new state with --status.
    await client.end()
    process.exit(process.exitCode ?? 0)
  }

  const pending = []
  for (const entry of order) {
    const sql = await readFile(entry.file, "utf8")
    const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16)
    const state = applied.has(entry.tag) ? "applied " : "PENDING"

    if (wantsStatus) {
      const tables = await createdTables(sql)
      const present = []
      const missing = []
      for (const table of tables) {
        const found = await client.query(
          `SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = $1`,
          [table]
        )
        ;(found.rows.length ? present : missing).push(table)
      }
      const evidence =
        tables.length === 0
          ? ""
          : missing.length === 0
            ? `  all ${tables.length} tables exist`
            : `  tables missing: ${missing.join(", ")}${present.length ? ` (present: ${present.join(", ")})` : ""}`
      console.log(
        `${state} ${entry.file}${entry.inJournal ? "" : "  [not in journal]"}${evidence}`
      )
    }

    if (!applied.has(entry.tag)) pending.push({ ...entry, sql, checksum })
  }

  if (wantsStatus) {
    console.log(
      `\n${applied.size} applied, ${pending.length} pending. Ledger table: paradox_migrations.`
    )
    if (pending.length > 0 && pending.some((entry) => !entry.inJournal)) {
      console.log(
        "Pending files not in the drizzle journal are applied by this runner only; drizzle-kit would skip them."
      )
    }
  } else if (pending.length === 0) {
    console.log("Database is up to date.")
  } else {
    for (const entry of pending) {
      process.stdout.write(`applying ${entry.file} ... `)
      try {
        await client.query(entry.sql)
        await client.query(
          "INSERT INTO paradox_migrations (tag, checksum) VALUES ($1, $2)",
          [entry.tag, entry.checksum]
        )
        console.log("ok")
      } catch (error) {
        console.log("FAILED")
        console.error(`\n${entry.file} failed (${error.code ?? "no code"}): ${error.message}`)
        console.error(
          [
            "Nothing from this file was committed (the statement batch rolled back).",
            "",
            "If this database already has these objects, the file was applied before this",
            "runner existed: verify with `node scripts/migrate.mjs --status` (it lists which",
            "tables of this file already exist) and then record it explicitly with",
            `  node scripts/migrate.mjs --mark ${entry.file}`,
            "before running the runner again. Do not mark a file whose tables are missing.",
          ].join("\n")
        )
        process.exit(1)
      }
    }
    console.log(`Applied ${pending.length} migration(s).`)
  }
} finally {
  await client.end()
}
