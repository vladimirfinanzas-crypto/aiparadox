// ---------------------------------------------------------------------------
// The panel document.
//
// A panel is not free-form HTML: it is a JSON document made of blocks from a
// fixed catalogue (heading, text, stats, table, checklist, list, calendar, form,
// chart). The agent writes documents, never code, and the runtime in
// components/panels/panel-view.tsx is the only thing that renders them.
//
// Everything here is tolerant on purpose: model output is untrusted, so values
// are clamped and unknown blocks are dropped rather than throwing. Whatever
// survives this file is safe to store and to render.
// ---------------------------------------------------------------------------

export const blockKinds = [
  "heading",
  "text",
  "stats",
  "table",
  "checklist",
  "list",
  "calendar",
  "form",
  "chart",
] as const

export type BlockKind = (typeof blockKinds)[number]

export type TableRow = { id: string; cells: string[] }
export type ChecklistItem = { id: string; label: string; detail?: string; done: boolean }
export type ListItem = { id: string; title: string; detail?: string; status?: string }
export type CalendarEvent = { id: string; date: string; title: string; detail?: string }
export type FormField = {
  id: string
  label: string
  kind: "text" | "textarea" | "date" | "select"
  options?: string[]
  value: string
}
export type ChartPoint = { label: string; value: number }

export type PanelBlock =
  | { id: string; type: "heading"; text: string; level: 1 | 2 | 3 }
  | { id: string; type: "text"; text: string }
  | { id: string; type: "stats"; title?: string; items: { label: string; value: string; hint?: string }[] }
  | { id: string; type: "table"; title?: string; columns: string[]; rows: TableRow[] }
  | { id: string; type: "checklist"; title?: string; items: ChecklistItem[] }
  | { id: string; type: "list"; title?: string; items: ListItem[] }
  | { id: string; type: "calendar"; title?: string; events: CalendarEvent[] }
  | { id: string; type: "form"; title?: string; submitLabel?: string; fields: FormField[] }
  | { id: string; type: "chart"; title?: string; series: ChartPoint[] }

export type PanelDocument = {
  version: 2
  description?: string
  blocks: PanelBlock[]
}

// Limits keep one oversized document from filling a row or freezing a page.
const MAX_BLOCKS = 24
const MAX_ITEMS = 200
const MAX_COLUMNS = 12

function str(value: unknown, max = 600): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : ""
  return text.trim().slice(0, max)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []
}

function slug(value: unknown, fallback: string): string {
  const text = str(value, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return text || fallback
}

function kind(value: unknown): BlockKind | null {
  const candidate = str(value, 20).toLowerCase()
  return (blockKinds as readonly string[]).includes(candidate)
    ? (candidate as BlockKind)
    : null
}

function level(value: unknown): 1 | 2 | 3 {
  const parsed = Number(value)
  return parsed === 1 || parsed === 3 ? parsed : 2
}

// A block's id is what lets the runtime save one block's data without touching
// the rest of the document, so it has to be stable and unique. The agent is
// asked for ids; when it leaves them out they fall back to the position, which
// is stable as long as the structure is not reordered.
export function normalizeBlock(input: unknown, index: number): PanelBlock | null {
  const raw = record(input)
  const type = kind(raw.type)
  if (!type) return null

  const id = slug(raw.id, `${type}-${index + 1}`)

  switch (type) {
    case "heading":
      return { id, type, text: str(raw.text, 200), level: level(raw.level) }

    case "text":
      return { id, type, text: str(raw.text, 2000) }

    case "stats":
      return {
        id,
        type,
        title: str(raw.title, 120) || undefined,
        items: list(raw.items)
          .slice(0, 12)
          .map((item) => {
            const value = record(item)
            return {
              label: str(value.label ?? value.title, 80),
              value: str(value.value, 40),
              hint: str(value.hint, 80) || undefined,
            }
          })
          .filter((item) => item.label || item.value),
      }

    case "table": {
      const columns = list(raw.columns)
        .slice(0, MAX_COLUMNS)
        .map((column) => str(column, 80))
      const rows = list(raw.rows)
        .map((row, rowIndex) => {
          const data = record(row)
          const cells = Array.isArray(row)
            ? row
            : Array.isArray(data.cells)
              ? data.cells
              : columns.map((column) => data[column])
          return {
            id: slug(data.id, `row-${rowIndex + 1}`),
            cells: cells.slice(0, columns.length).map((cell) => str(cell, 300)),
          }
        })
        .filter((row) => row.cells.some(Boolean))
      return {
        id,
        type,
        title: str(raw.title, 120) || undefined,
        columns: columns.length > 0 ? columns : ["Columna 1", "Columna 2"],
        rows,
      }
    }

    case "checklist":
      return {
        id,
        type,
        title: str(raw.title, 120) || undefined,
        items: list(raw.items)
          .map((item, itemIndex) => {
            const value = record(item)
            return {
              id: slug(value.id, `item-${itemIndex + 1}`),
              label: str(value.label ?? value.text ?? value.title, 200),
              detail: str(value.detail, 300) || undefined,
              done: value.done === true || value.status === "done",
            }
          })
          .filter((item) => item.label),
      }

    case "list":
      return {
        id,
        type,
        title: str(raw.title, 120) || undefined,
        items: list(raw.items)
          .map((item, itemIndex) => {
            const value = record(item)
            return {
              id: slug(value.id, `item-${itemIndex + 1}`),
              title: str(value.title ?? value.label ?? value.text, 200),
              detail: str(value.detail ?? value.description, 400) || undefined,
              status: str(value.status, 40) || undefined,
            }
          })
          .filter((item) => item.title),
      }

    case "calendar":
      return {
        id,
        type,
        title: str(raw.title, 120) || undefined,
        events: list(raw.events ?? raw.items)
          .map((event, eventIndex) => {
            const value = record(event)
            return {
              id: slug(value.id, `event-${eventIndex + 1}`),
              date: normalizeDate(value.date),
              title: str(value.title ?? value.label, 160),
              detail: str(value.detail, 240) || undefined,
            }
          })
          .filter((event) => event.date && event.title),
      }

    case "form":
      return {
        id,
        type,
        title: str(raw.title, 120) || undefined,
        submitLabel: str(raw.submitLabel, 40) || "Guardar",
        fields: list(raw.fields)
          .slice(0, 12)
          .map((field, fieldIndex) => {
            const value = record(field)
            const fieldKind = str(value.kind ?? value.type, 20).toLowerCase()
            const options = list(value.options)
              .map((option) => str(option, 60))
              .filter(Boolean)
            return {
              id: slug(value.id ?? value.name, `field-${fieldIndex + 1}`),
              label: str(value.label ?? value.name, 80),
              kind: (["text", "textarea", "date", "select"].includes(fieldKind)
                ? fieldKind
                : "text") as FormField["kind"],
              options: options.length > 0 ? options : undefined,
              value: str(value.value, 2000),
            }
          })
          .filter((field) => field.label),
      }

    case "chart":
      return {
        id,
        type,
        title: str(raw.title, 120) || undefined,
        series: list(raw.series ?? raw.items)
          .slice(0, 24)
          .map((point) => {
            const value = record(point)
            return {
              label: str(value.label ?? value.name, 60),
              value: Number(value.value ?? value.count) || 0,
            }
          })
          .filter((point) => point.label),
      }
  }
}

function normalizeDate(value: unknown): string {
  const text = str(value, 40)
  if (!text) return ""
  // YYYY-MM-DD is what <input type="date"> and the ISO comparison below use
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString().slice(0, 10)
}

export function normalizeBlocks(input: unknown): PanelBlock[] {
  const seen = new Set<string>()
  const blocks: PanelBlock[] = []

  for (const [index, candidate] of list(input).slice(0, MAX_BLOCKS).entries()) {
    const block = normalizeBlock(candidate, index)
    if (!block) continue
    // Duplicate ids would make two blocks share one saved payload
    let id = block.id
    let suffix = 2
    while (seen.has(id)) id = `${block.id}-${suffix++}`
    seen.add(id)
    blocks.push({ ...block, id })
  }

  return blocks
}

export function createDocument(input: {
  description?: string
  blocks: unknown
}): PanelDocument {
  const description = str(input.description, 400) || undefined
  return { version: 2, description, blocks: normalizeBlocks(input.blocks) }
}

// Maps the shapes panels used before documents existed — posts, a column/row
// table, metrics — into real blocks, so an old panel opens as an editable one
// instead of a JSON dump.
export function documentFromLegacy(
  type: string,
  config: Record<string, unknown>
): PanelDocument {
  const blocks: PanelBlock[] = []
  const title = str(config.title, 120)

  const posts = Array.isArray(config.posts) ? config.posts : null
  const columns = Array.isArray(config.columns) ? config.columns : null
  const rows = Array.isArray(config.rows) ? config.rows : null
  const metrics = Array.isArray(config.metrics)
    ? config.metrics
    : Array.isArray(config.items)
      ? config.items
      : null

  if (title) {
    blocks.push({ id: "heading-1", type: "heading", text: title, level: 2 })
  }

  if (posts && posts.length > 0) {
    blocks.push(
      normalizeBlock(
        {
          id: "publicaciones",
          type: "table",
          title: "Publicaciones",
          columns: ["Contenido", "Red", "Estado", "Programado"],
          rows: posts.map((post, index) => {
            const item = record(post)
            return {
              id: `post-${index + 1}`,
              cells: [
                str(item.content, 300),
                str(item.platform, 40),
                str(item.status, 40) || "borrador",
                str(item.scheduledFor, 40),
              ],
            }
          }),
        },
        0
      )!
    )
  } else if (columns && rows && rows.length > 0) {
    blocks.push(
      normalizeBlock(
        { id: "tabla", type: "table", columns, rows },
        blocks.length
      )!
    )
  } else if (metrics && metrics.length > 0) {
    blocks.push(
      normalizeBlock(
        { id: "metricas", type: "stats", title: title || "Resumen", items: metrics },
        blocks.length
      )!
    )
  }

  if (blocks.length === 0) {
    // Unknown shape: show its key/value pairs rather than pretending it is empty
    const entries = Object.entries(config).filter(
      ([key]) => key !== "version" && key !== "description"
    )
    blocks.push({
      id: "texto-1",
      type: "text",
      text: str(title || type || "Panel", 200),
    })
    if (entries.length > 0) {
      blocks.push(
        normalizeBlock(
          {
            id: "detalle",
            type: "table",
            columns: ["Campo", "Valor"],
            rows: entries.slice(0, 12).map(([key, value], index) => ({
              id: `row-${index + 1}`,
              cells: [
                key,
                typeof value === "string" ? value : JSON.stringify(value),
              ],
            })),
          },
          blocks.length
        )!
      )
    }
  }

  return {
    version: 2,
    description: str(config.description, 400) || undefined,
    blocks,
  }
}

export function readPanelDocument(config: unknown): PanelDocument {
  const raw = record(config)

  if (raw.version === 2 && Array.isArray(raw.blocks)) {
    return {
      version: 2,
      description: str(raw.description, 400) || undefined,
      blocks: normalizeBlocks(raw.blocks),
    }
  }

  return documentFromLegacy(str(raw.type, 50), raw)
}

// Writes the document back into the widget's config without dropping keys the
// row already had, so nothing an older panel stored disappears silently.
export function configFromDocument(
  config: unknown,
  document: PanelDocument
): Record<string, unknown> {
  return {
    ...record(config),
    version: 2,
    description: document.description,
    blocks: document.blocks,
  }
}

// Structure edits must never discard what the person already put in. When the
// agent rewrites a document, blocks it kept (same id, same type) keep their
// rows, ticks, events and typed values; only the layout around them changes.
export function mergePanelDocuments(
  previous: PanelDocument,
  next: PanelDocument
): PanelDocument {
  const before = new Map(previous.blocks.map((block) => [block.id, block]))

  return {
    version: 2,
    description: next.description ?? previous.description,
    blocks: next.blocks.map((block) => {
      const old = before.get(block.id)
      if (!old || old.type !== block.type) return block
      return applyBlockData(block, mutableData(old)) ?? block
    }),
  }
}

// The part of a block the person changes at runtime: what gets saved and what
// survives a structural edit.
export function mutableData(block: PanelBlock): unknown {
  switch (block.type) {
    case "table":
      return { rows: block.rows }
    case "checklist":
      return { items: block.items }
    case "list":
      return { items: block.items }
    case "calendar":
      return { events: block.events }
    case "form":
      return { fields: block.fields }
    default:
      return null
  }
}

// Applies one block's runtime data back onto it, keeping its type and the shape
// the renderer expects. Returns null when the payload does not fit the block.
export function applyBlockData(block: PanelBlock, data: unknown): PanelBlock | null {
  const raw = record(data)

  switch (block.type) {
    case "table": {
      if (!Array.isArray(raw.rows)) return null
      const rows = normalizeBlock(
        { ...block, rows: raw.rows },
        0
      )
      return rows && rows.type === "table" ? rows : null
    }
    case "checklist": {
      if (!Array.isArray(raw.items)) return null
      const next = normalizeBlock({ ...block, items: raw.items }, 0)
      return next && next.type === "checklist" ? next : null
    }
    case "list": {
      if (!Array.isArray(raw.items)) return null
      const next = normalizeBlock({ ...block, items: raw.items }, 0)
      return next && next.type === "list" ? next : null
    }
    case "calendar": {
      if (!Array.isArray(raw.events)) return null
      const next = normalizeBlock({ ...block, events: raw.events }, 0)
      return next && next.type === "calendar" ? next : null
    }
    case "form": {
      if (!Array.isArray(raw.fields)) return null
      const next = normalizeBlock({ ...block, fields: raw.fields }, 0)
      return next && next.type === "form" ? next : null
    }
    default:
      return null
  }
}

// What the runtime in panel-view.tsx writes back, per block type. Those keys
// are the person's data, not the layout.
const runtimeKeys: Partial<Record<BlockKind, string>> = {
  table: "rows",
  checklist: "items",
  list: "items",
  calendar: "events",
  form: "fields",
}

// The structural part of a block: what a version records. Ticking a box or
// typing in a cell changes the data, not the layout, so it must not create a
// version — otherwise the history fills with one entry per keystroke. Fields
// the runtime never writes (stats, chart, text…) stay part of the layout, so a
// change to them is still saved and versioned.
function structuralShape(block: PanelBlock): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...block }
  const runtime = runtimeKeys[block.type]
  if (runtime) delete copy[runtime]
  return copy
}

// A stable key for the layout, used to decide whether a save is a new version.
// Description counts: it is what the library and the agent read as the panel's
// purpose.
export function structureKey(document: PanelDocument): string {
  return JSON.stringify({
    description: document.description ?? null,
    blocks: document.blocks.map(structuralShape),
  })
}

export function structureChanged(previous: PanelDocument, next: PanelDocument) {
  return structureKey(previous) !== structureKey(next)
}

const blockLabels: Record<BlockKind, string> = {
  heading: "título",
  text: "texto",
  stats: "métricas",
  table: "tabla",
  checklist: "checklist",
  list: "lista",
  calendar: "calendario",
  form: "formulario",
  chart: "gráfico",
}

// One line for the library card and the chat: what this panel is made of.
export function documentSummary(document: PanelDocument): string {
  if (document.blocks.length === 0) return "Sin contenido todavía"

  const counts = new Map<BlockKind, number>()
  for (const block of document.blocks) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([type, count]) => `${count} ${blockLabels[type]}`)
    .join(" · ")
}
