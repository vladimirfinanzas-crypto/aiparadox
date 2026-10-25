import { parseEnv } from "@neon/env"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import config from "@/neon"

import * as schema from "./schema"

// Reuse the pool across HMR reloads in development
const globalForDb = globalThis as unknown as { pool?: Pool }

function createPool() {
  // Pooled connection string for application traffic
  const { postgres } = parseEnv(config, ["DATABASE_URL"])
  const url = new URL(postgres.databaseUrl)
  // pg treats prefer/require/verify-ca as aliases for verify-full anyway;
  // spelling it out silences their deprecation warning with identical behavior
  const sslmode = url.searchParams.get("sslmode")
  if (sslmode && sslmode !== "verify-full") {
    url.searchParams.set("sslmode", "verify-full")
  }
  return new Pool({ connectionString: url.toString() })
}

const pool = globalForDb.pool ?? createPool()

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool
}

export const db = drizzle({ client: pool, schema, casing: "snake_case" })
