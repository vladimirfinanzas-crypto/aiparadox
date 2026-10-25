// Titles and previews for the conversation history, derived from what the
// person actually wrote — never invented, never a generic "New Chat".
//
// Both helpers are pure so the rules (one line, word-boundary truncation,
// empty → null) can be unit-tested without touching the database.

const TITLE_MAX = 48
const PREVIEW_MAX = 120

/** Collapses every run of whitespace so a multi-line prompt becomes one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Truncates at a word boundary when possible, so a title never ends mid-word.
 * The ellipsis counts toward `max`.
 */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The conversation's title from its first user message, or null if empty. */
export function deriveChatTitle(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null
  const title = clamp(oneLine(text), TITLE_MAX)
  return title ? title : null
}

/** The history's one-line preview of the latest message, or null if empty. */
export function deriveChatPreview(
  text: string | null | undefined
): string | null {
  if (typeof text !== "string") return null
  const preview = clamp(oneLine(text), PREVIEW_MAX)
  return preview ? preview : null
}

// The shapes a turn's messages may arrive in: the managed chat's `content`
// (string or parts) and the AI SDK's `parts`. Only text parts count — an image
// or a tool result is not something to title a conversation with.
type MessageLike = {
  role: string
  content?: unknown
  parts?: unknown
}

function partText(part: unknown): string {
  if (typeof part === "string") return part
  if (part && typeof part === "object" && "text" in part) {
    const text = (part as { text?: unknown }).text
    return typeof text === "string" ? text : ""
  }
  return ""
}

function messageText(message: MessageLike): string {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content.map(partText).filter(Boolean).join(" ")
  }
  if (Array.isArray(message.parts)) {
    return message.parts.map(partText).filter(Boolean).join(" ")
  }
  return ""
}

/** The first thing the person said in the conversation, or "" if none yet. */
export function firstUserText(messages: readonly MessageLike[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = messageText(message).trim()
    if (text) return text
  }
  return ""
}
