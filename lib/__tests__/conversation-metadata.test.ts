import { describe, expect, it } from "vitest"

import {
  deriveChatPreview,
  deriveChatTitle,
  firstUserText,
} from "@/lib/conversation-metadata"

describe("deriveChatTitle", () => {
  it("uses the message as a single line", () => {
    expect(deriveChatTitle("  comprueba   los vuelos\na Tokio  ")).toBe(
      "comprueba los vuelos a Tokio"
    )
  })

  it("truncates a long message at a word boundary with an ellipsis", () => {
    const title = deriveChatTitle("x".repeat(200))
    expect(title).toHaveLength(48)
    expect(title?.endsWith("…")).toBe(true)

    const words = "analiza ".repeat(30).trim()
    const wordTitle = deriveChatTitle(words)
    expect(wordTitle!.length).toBeLessThanOrEqual(48)
    expect(wordTitle!.endsWith("…")).toBe(true)
    // Never mid-word when a boundary exists inside the window
    expect(wordTitle!.slice(0, -1).endsWith(" ")).toBe(false)
  })

  it("returns null for empty or whitespace-only input", () => {
    expect(deriveChatTitle("")).toBeNull()
    expect(deriveChatTitle("   \n\t ")).toBeNull()
    expect(deriveChatTitle(undefined)).toBeNull()
    expect(deriveChatTitle(null)).toBeNull()
  })

  it("leaves a short message untouched", () => {
    expect(deriveChatTitle("Hola")).toBe("Hola")
  })
})

describe("deriveChatPreview", () => {
  it("collapses whitespace and clamps to 120 characters", () => {
    const preview = deriveChatPreview(`pide\n\tresumen de ${"documento ".repeat(40)}`)
    expect(preview).not.toContain("\n")
    expect(preview!.length).toBeLessThanOrEqual(120)
  })

  it("returns null when there is nothing to show", () => {
    expect(deriveChatPreview("")).toBeNull()
    expect(deriveChatPreview("  ")).toBeNull()
  })
})

describe("firstUserText", () => {
  it("finds the first user message, skipping system and assistant turns", () => {
    expect(
      firstUserText([
        { role: "system", content: "instrucciones" },
        { role: "assistant", content: "hola" },
        { role: "user", content: "primer encargo" },
        { role: "user", content: "segundo encargo" },
      ])
    ).toBe("primer encargo")
  })

  it("joins text parts and ignores images and tool parts", () => {
    expect(
      firstUserText([
        {
          role: "user",
          parts: [
            { type: "text", text: "mira" },
            { type: "file", mediaType: "image/png" },
            { type: "text", text: "esta imagen" },
          ],
        },
      ])
    ).toBe("mira esta imagen")
  })

  it("works with the AI SDK `parts` shape and skips empty user messages", () => {
    expect(
      firstUserText([
        { role: "user", parts: [{ type: "text", text: "   " }] },
        { role: "user", parts: [{ type: "text", text: "real" }] },
      ])
    ).toBe("real")
    expect(firstUserText([{ role: "assistant", content: "solo yo" }])).toBe("")
    expect(firstUserText([])).toBe("")
  })
})
