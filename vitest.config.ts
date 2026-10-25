import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// The app imports through the `@/*` alias from tsconfig; Vitest does not read
// tsconfig paths on its own, so it is repeated here. Tests are plain node
// modules — none of them renders React or touches a browser.
const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
})
