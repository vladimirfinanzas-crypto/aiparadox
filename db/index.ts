import { parseEnv } from "@neon/env"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import config from "@/neon"

import * as schema from "./schema"

/**
 * The pool and the Drizzle client are created on FIRST USE, not at import time.
 *
 * Why: Next.js imports every route/page module while collecting page data
 * during `next build`. If this module read DATABASE_URL eagerly, the build of
 * the whole app would depend on a runtime secret being present in the build
 * environment — and a missing variable surfaced as an opaque
 * `PLATFORM_ENV_NOT_INJECTED` crash attributed to some unrelated route.
 *
 * Nothing here is faked: with DATABASE_URL missing, the first real query throws
 * `DatabaseNotConfiguredError` naming the variable, and request paths that do
 * not touch the database keep working (e.g. /api/health).
 */
export type Database = NodePgDatabase<typeof schema> & { $client: Pool }

export class DatabaseNotConfiguredError extends Error {
  constructor(cause?: unknown) {
    super(
      "DatabaseNotConfiguredError: DATABASE_URL is not set. Add it to .env.local " +
        "(development) or to the deployment's environment variables. No query " +
        "can run without it.",
      { cause }
    )
    this.name = "DatabaseNotConfiguredError"
  }
}

// Reuse the connection across HMR reloads in development
const globalForDb = globalThis as unknown as {
  pool?: Pool
  db?: Database
}

function createPool(): Pool {
  let databaseUrl: string
  try {
    // Pooled connection string for application traffic
    databaseUrl = parseEnv(config, ["DATABASE_URL"]).postgres.databaseUrl
  } catch (error) {
    throw new DatabaseNotConfiguredError(error)
  }

  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch (error) {
    // A set-but-malformed URL is a different problem from a missing one, and it
    // deserves its own message instead of a bare SyntaxError from `new URL`.
    throw new Error(
      "DATABASE_URL is not a valid connection URL (expected something like postgresql://user:pass@host/db).",
      { cause: error }
    )
  }

  // pg treats prefer/require/verify-ca as aliases for verify-full anyway;
  // spelling it out silences their deprecation warning with identical behavior
  const sslmode = url.searchParams.get("sslmode")
  if (sslmode && sslmode !== "verify-full") {
    url.searchParams.set("sslmode", "verify-full")
  }
  return new Pool({ connectionString: url.toString() })
}

function createDatabase(): Database {
  const pool = globalForDb.pool ?? createPool()
  const instance = drizzle({ client: pool, schema, casing: "snake_case" }) as Database

  if (process.env.NODE_ENV !== "production") {
    globalForDb.pool = pool
    globalForDb.db = instance
  }

  return instance
}

/** The lazily created client, or a loud configuration error. */
export function getDb(): Database {
  return globalForDb.db ?? createDatabase()
}

/**
 * `db` is the real Drizzle client behind a proxy: every property access
 * resolves to the instance created on first touch. Call sites keep using
 * `db.select(...)`, `db.query...` and `db.transaction(...)` unchanged.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const instance = getDb()
    const value = Reflect.get(instance, property, instance)
    // Methods are bound to the real instance so `db.select(...)` keeps its `this`.
    return typeof value === "function" ? value.bind(instance) : value
  },
  has(_target, property) {
    return Reflect.has(getDb(), property)
  },
  ownKeys() {
    return Reflect.ownKeys(getDb())
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(getDb(), property)
  },
})
