// One-off migration: legacy flow graphs → v2 definitions.
//
// The old canvas kept the authoritative graph in a Liveblocks room and copied it
// to `workflows.graph` only when someone pressed Run. This script reads both
// places, keeps the version that actually has blocks, and writes a v2
// definition plus its first `automation_versions` row.
//
//   node scripts/migrate-liveblocks-graphs.mjs [--dry-run]
//
// It is additive and idempotent: rows that already have a definition are left
// alone, so running it twice changes nothing.

import { Client } from "pg"

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file)
  } catch {
    // The value may come from the shell instead
  }
}

const dryRun = process.argv.includes("--dry-run")

const raw = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
if (!raw) {
  console.error("Neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set.")
  process.exit(1)
}

const url = new URL(raw)
const sslmode = url.searchParams.get("sslmode")
if (sslmode && sslmode !== "verify-full") url.searchParams.set("sslmode", "verify-full")

const KIND = { start: "trigger", condition: "condition" }
const LOCAL_NODES = new Set(["desktop-action"])
const CLOUD_NODES = new Set([
  "open-url",
  "act",
  "extract",
  "observe",
  "agent",
  "send-email",
  "publish-social",
])

function definitionFrom(name, timezone, graphNodes, graphEdges) {
  const nodes = graphNodes.map((node, index) => {
    const data = node.data ?? {}
    const type = data.type ?? "start"
    return {
      id: String(node.id),
      type,
      kind: KIND[type] ?? "action",
      title: data.title ?? type,
      config: Object.fromEntries(
        Object.entries(data.values ?? {}).map(([key, value]) => [key, String(value ?? "")])
      ),
      position: {
        x: Number(node.position?.x ?? index * 260),
        y: Number(node.position?.y ?? 0),
      },
    }
  })

  const edges = graphEdges.map((edge, index) => ({
    id: String(edge.id ?? `edge-${index}`),
    source: String(edge.source),
    target: String(edge.target),
    ...(edge.sourceHandle === "true" || edge.sourceHandle === "false"
      ? { sourceHandle: edge.sourceHandle }
      : {}),
  }))

  const hasLocal = nodes.some((node) => LOCAL_NODES.has(node.type))
  const hasCloud = nodes.some((node) => CLOUD_NODES.has(node.type))

  return {
    definition: {
      schemaVersion: 2,
      name,
      trigger: { kind: "manual", timezone: timezone || "UTC" },
      nodes,
      edges,
      settings: { onError: "stop", retries: 0, maxSteps: 40, timeoutMs: 900000 },
    },
    executionTarget: hasLocal && hasCloud ? "hybrid" : hasLocal ? "local" : "cloud",
  }
}

async function roomGraph(client, workflowId) {
  if (!process.env.LIVEBLOCKS_SECRET_KEY) return null
  try {
    const { Liveblocks } = await import("@liveblocks/node")
    const liveblocks = new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET_KEY })
    const doc = await liveblocks.getStorageDocument(workflowId, "json")
    const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
    const edges = Array.isArray(doc?.edges) ? doc.edges : []
    if (nodes.length === 0) return null
    return { nodes, edges }
  } catch {
    return null
  }
}

const client = new Client({ connectionString: url.toString() })
await client.connect()

try {
  const { rows } = await client.query(
    `select id, name, graph, definition, timezone from workflows order by created_at`
  )

  console.log(`${rows.length} automatizaciones en la base de datos`)

  let migrated = 0
  let skipped = 0

  for (const row of rows) {
    if (row.definition) {
      skipped += 1
      console.log(`· ${row.name} — ya tiene definición, se deja igual`)
      continue
    }

    const legacyNodes = row.graph?.nodes ?? []
    const legacyEdges = row.graph?.edges ?? []
    const room = await roomGraph(client, row.id)

    const fromDb = legacyNodes.length > 0
    const source = fromDb ? "postgres" : room ? "liveblocks" : "vacío"
    const nodes = fromDb ? legacyNodes : (room?.nodes ?? [])
    const edges = fromDb ? legacyEdges : (room?.edges ?? [])

    const { definition, executionTarget } = definitionFrom(
      row.name,
      row.timezone,
      nodes,
      edges
    )

    console.log(
      `· ${row.name} — ${nodes.length} bloques / ${edges.length} conexiones desde ${source}`
    )

    if (dryRun) continue

    await client.query("begin")
    try {
      await client.query(
        `update workflows
            set definition = $2, version = 1, execution_target = $3, updated_at = now()
          where id = $1`,
        [row.id, JSON.stringify(definition), executionTarget]
      )
      await client.query(
        `insert into automation_versions (workflow_id, user_id, version, definition, author, summary)
         select id, user_id, 1, $2, 'migration', 'Importada desde el lienzo anterior'
           from workflows where id = $1
         on conflict (workflow_id, version) do nothing`,
        [row.id, JSON.stringify(definition)]
      )
      await client.query("commit")
      migrated += 1
    } catch (error) {
      await client.query("rollback")
      console.error(`  ! ${row.name}: ${error.message}`)
    }
  }

  console.log(
    dryRun
      ? `Simulación: ${rows.length} revisadas, ${skipped} ya migradas.`
      : `Migradas ${migrated}, ya estaban ${skipped}.`
  )
} finally {
  await client.end()
}
