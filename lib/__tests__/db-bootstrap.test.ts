import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The database client must be importable with no configuration at all.
//
// `next build` imports every route and page module while collecting page data;
// an eager DATABASE_URL read made the whole build depend on a runtime secret and
// reported the failure against an unrelated route. Configuration is therefore
// deferred to the first real query, and that is what these tests pin down.
describe("database bootstrap", () => {
  const original = process.env.DATABASE_URL

  beforeEach(() => {
    delete process.env.DATABASE_URL
    vi.resetModules()
  })

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = original
    vi.resetModules()
  })

  it("imports without DATABASE_URL, so a build needs no database", async () => {
    const mod = await import("@/db")

    expect(typeof mod.getDb).toBe("function")
    expect(mod.db).toBeTruthy()
  })

  it("fails loudly, and by name, on the first real use", async () => {
    const { db, getDb, DatabaseNotConfiguredError } = await import("@/db")

    expect(() => getDb()).toThrow(DatabaseNotConfiguredError)
    expect(() => getDb()).toThrow(/DATABASE_URL is not set/)

    // The proxy resolves lazily: touching a query method is what fails, not the
    // import that a page or route handler performs.
    expect(() => db.select).toThrow(DatabaseNotConfiguredError)
  })
})
