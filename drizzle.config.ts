import { existsSync } from "node:fs"
import { defineConfig } from "drizzle-kit"

// Hosted builds use injected environment variables and may not have this file.
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local")
}

export default defineConfig({
  schema: "./db/schema.ts",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    // Direct (non-pooled) connection: schema changes need session state
    url: process.env.DATABASE_URL_UNPOOLED!,
  },
})
