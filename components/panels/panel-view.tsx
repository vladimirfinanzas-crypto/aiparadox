"use client"

import { useRef, useState } from "react"
import {
  CheckIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import { savePanelBlock } from "@/actions/widget"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  mutableData,
  type CalendarEvent,
  type ChecklistItem,
  type ListItem,
  type PanelBlock,
  type PanelDocument,
  type TableRow,
} from "@/lib/panels/document"
import { appearanceCss, appearanceOf } from "@/lib/panels/appearance"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The panel runtime.
//
// Every panel is drawn from the same catalogue of blocks, and the only writes it
// can make are the ones savePanelBlock accepts: rows, ticks, events and typed
// values for one block of a panel this account owns. There is no generated HTML
// or JavaScript anywhere in this path.
// ---------------------------------------------------------------------------

type SaveState = "idle" | "saving" | "saved" | "error"

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function formatDate(value: string) {
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat("es-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(parsed)
}

export function PanelView({
  widgetId,
  document,
  readOnly = false,
}: {
  widgetId: string
  document: PanelDocument
  readOnly?: boolean
}) {
  const [blocks, setBlocks] = useState<PanelBlock[]>(document.blocks)
  const blocksRef = useRef(blocks)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [state, setState] = useState<SaveState>("idle")
  const [error, setError] = useState<string | null>(null)

  // The look lives in the document: three colours become custom properties on
  // the root, layout and density become classes on the block list. Every value
  // is already an id from the whitelist, never raw CSS.
  const appearance = appearanceOf(document)
  const blocksClass = cn(
    appearance.layout === "grid" ? "grid gap-x-4 sm:grid-cols-2" : "flex flex-col",
    appearance.density === "compact" ? "gap-y-2" : "gap-y-5"
  )

  const send = async (block: PanelBlock) => {
    setState("saving")
    setError(null)
    const result = await savePanelBlock(widgetId, block.id, mutableData(block))
    if (result.ok) {
      setState("saved")
      return
    }
    setState("error")
    setError(result.error)
  }

  // Toggles and deletions save at once; typing waits until the person pauses,
  // so a sentence is not one request per key.
  const schedule = (block: PanelBlock, immediate: boolean) => {
    const existing = timers.current.get(block.id)
    if (existing) clearTimeout(existing)

    if (immediate) {
      timers.current.delete(block.id)
      void send(block)
      return
    }

    timers.current.set(
      block.id,
      setTimeout(() => {
        timers.current.delete(block.id)
        void send(block)
      }, 600)
    )
  }

  const update = (
    blockId: string,
    updater: (block: PanelBlock) => PanelBlock,
    immediate = true
  ) => {
    const next = blocksRef.current.map((block) =>
      block.id === blockId ? updater(block) : block
    )
    blocksRef.current = next
    setBlocks(next)

    const changed = next.find((block) => block.id === blockId)
    if (changed) schedule(changed, immediate)
  }

  if (blocks.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed p-10 text-center">
        <p className="font-medium">Este panel todavía no tiene contenido</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Pídele al agente que lo diseñe: títulos, tablas, checklists o
          formularios. Después podrás usarlo y sus datos se guardarán solos.
        </p>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-5"
      style={appearanceCss(appearance) as React.CSSProperties}
    >
      {!readOnly && (
        <p
          aria-live="polite"
          className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
        >
          {state === "saving" && "Guardando…"}
          {state === "saved" && (
            <>
              <CheckIcon className="size-3 text-emerald-400" aria-hidden />
              Guardado
            </>
          )}
          {state === "error" && (
            <>
              <TriangleAlertIcon className="size-3 text-destructive" aria-hidden />
              <span className="text-destructive">
                {error ?? "No se pudo guardar"}
              </span>
            </>
          )}
        </p>
      )}

      <div className={blocksClass}>
      {blocks.map((block) => (
        <Section key={block.id} block={block}>
          {block.type === "heading" && (
            <h2
              className={
                block.level === 1
                  ? "text-2xl font-semibold tracking-tight"
                  : block.level === 3
                    ? "text-base font-semibold"
                    : "text-lg font-semibold tracking-tight"
              }
            >
              {block.text || "Sin título"}
            </h2>
          )}

          {block.type === "text" && (
            <p className="max-w-2xl whitespace-pre-wrap text-sm text-muted-foreground">
              {block.text}
            </p>
          )}

          {block.type === "stats" && (
            <>
              {block.title && <SectionTitle>{block.title}</SectionTitle>}
              {block.items.length === 0 ? (
                <EmptyLine>Sin cifras todavía</EmptyLine>
              ) : (
                <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {block.items.map((item, index) => (
                    <div
                      key={`${item.label}-${index}`}
                      className="rounded-xl border border-border/40 bg-background/40 px-4 py-3"
                    >
                      <dd className="text-2xl font-semibold tabular-nums">
                        {item.value || "—"}
                      </dd>
                      <dt className="text-xs text-muted-foreground">
                        {item.label}
                      </dt>
                      {item.hint && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {item.hint}
                        </p>
                      )}
                    </div>
                  ))}
                </dl>
              )}
            </>
          )}

          {block.type === "table" && (
            <>
              {block.title && <SectionTitle>{block.title}</SectionTitle>}
              <div className="overflow-x-auto rounded-xl border border-border/40">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      {block.columns.map((column) => (
                        <th key={column} className="px-3 py-2 font-medium">
                          {column}
                        </th>
                      ))}
                      {!readOnly && <th className="w-10 px-2 py-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {block.rows.length === 0 && (
                      <tr>
                        <td
                          colSpan={block.columns.length + (readOnly ? 0 : 1)}
                          className="px-3 py-6 text-center text-sm text-muted-foreground"
                        >
                          {readOnly
                            ? "Sin filas todavía"
                            : "Sin filas todavía. Añade la primera abajo."}
                        </td>
                      </tr>
                    )}
                    {block.rows.map((row, rowIndex) => (
                      <tr key={row.id}>
                        {block.columns.map((column, columnIndex) => (
                          <td key={column} className="px-3 py-1.5">
                            {readOnly ? (
                              <span>{row.cells[columnIndex] ?? ""}</span>
                            ) : (
                              <Input
                                value={row.cells[columnIndex] ?? ""}
                                aria-label={`${column}, fila ${rowIndex + 1}`}
                                onChange={(event) => {
                                  const value = event.target.value
                                  update(
                                    block.id,
                                    (current) =>
                                      current.type === "table"
                                        ? {
                                            ...current,
                                            rows: current.rows.map((entry) =>
                                              entry.id === row.id
                                                ? {
                                                    ...entry,
                                                    cells: entry.cells.map(
                                                      (cell, index) =>
                                                        index === columnIndex
                                                          ? value
                                                          : cell
                                                    ),
                                                  }
                                                : entry
                                            ),
                                          }
                                        : current,
                                    false
                                  )
                                }}
                                className="h-8 border-transparent bg-transparent px-1.5 shadow-none hover:border-border focus-visible:border-ring"
                              />
                            )}
                          </td>
                        ))}
                        {!readOnly && (
                          <td className="px-2 py-1.5">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Eliminar fila ${rowIndex + 1}`}
                              onClick={() =>
                                update(block.id, (current) =>
                                  current.type === "table"
                                    ? {
                                        ...current,
                                        rows: current.rows.filter(
                                          (entry) => entry.id !== row.id
                                        ),
                                      }
                                    : current
                                )
                              }
                            >
                              <Trash2Icon />
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-fit"
                  onClick={() =>
                    update(block.id, (current) =>
                      current.type === "table"
                        ? {
                            ...current,
                            rows: [
                              ...current.rows,
                              {
                                id: newId("fila"),
                                cells: current.columns.map(() => ""),
                              } satisfies TableRow,
                            ],
                          }
                        : current
                    )
                  }
                >
                  <PlusIcon data-icon="inline-start" />
                  Añadir fila
                </Button>
              )}
            </>
          )}

          {block.type === "checklist" && (
            <>
              {block.title && (
                <div className="flex items-baseline justify-between gap-2">
                  <SectionTitle>{block.title}</SectionTitle>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {block.items.filter((item) => item.done).length}/
                    {block.items.length}
                  </span>
                </div>
              )}
              {block.items.length === 0 ? (
                <EmptyLine>
                  Sin elementos todavía. Añade el primero abajo.
                </EmptyLine>
              ) : (
                <ul className="flex flex-col gap-1">
                  {block.items.map((item) => (
                    <li
                      key={item.id}
                      className="group flex items-start gap-3 rounded-lg px-1 py-1.5"
                    >
                      <input
                        type="checkbox"
                        checked={item.done}
                        disabled={readOnly}
                        aria-label={item.label}
                        onChange={() =>
                          update(block.id, (current) =>
                            current.type === "checklist"
                              ? {
                                  ...current,
                                  items: current.items.map((entry) =>
                                    entry.id === item.id
                                      ? { ...entry, done: !entry.done }
                                      : entry
                                  ),
                                }
                              : current
                          )
                        }
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={
                            item.done
                              ? "text-sm text-muted-foreground line-through"
                              : "text-sm"
                          }
                        >
                          {item.label}
                        </p>
                        {item.detail && (
                          <p className="text-xs text-muted-foreground">
                            {item.detail}
                          </p>
                        )}
                      </div>
                      {!readOnly && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Eliminar ${item.label}`}
                          onClick={() =>
                            update(block.id, (current) =>
                              current.type === "checklist"
                                ? {
                                    ...current,
                                    items: current.items.filter(
                                      (entry) => entry.id !== item.id
                                    ),
                                  }
                                : current
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly && (
                <AddInline
                  placeholder="Añadir elemento"
                  onAdd={(label) =>
                    update(block.id, (current) =>
                      current.type === "checklist"
                        ? {
                            ...current,
                            items: [
                              ...current.items,
                              {
                                id: newId("item"),
                                label,
                                done: false,
                              } satisfies ChecklistItem,
                            ],
                          }
                        : current
                    )
                  }
                />
              )}
            </>
          )}

          {block.type === "list" && (
            <>
              {block.title && <SectionTitle>{block.title}</SectionTitle>}
              {block.items.length === 0 ? (
                <EmptyLine>
                  Sin elementos todavía. Añade el primero abajo.
                </EmptyLine>
              ) : (
                <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/40">
                  {block.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-3 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{item.title}</p>
                        {item.detail && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.detail}
                          </p>
                        )}
                      </div>
                      {item.status && (
                        <Badge variant="outline">{item.status}</Badge>
                      )}
                      {!readOnly && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Eliminar ${item.title}`}
                          onClick={() =>
                            update(block.id, (current) =>
                              current.type === "list"
                                ? {
                                    ...current,
                                    items: current.items.filter(
                                      (entry) => entry.id !== item.id
                                    ),
                                  }
                                : current
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly && (
                <AddInline
                  placeholder="Añadir elemento"
                  onAdd={(title) =>
                    update(block.id, (current) =>
                      current.type === "list"
                        ? {
                            ...current,
                            items: [
                              ...current.items,
                              { id: newId("item"), title } satisfies ListItem,
                            ],
                          }
                        : current
                    )
                  }
                />
              )}
            </>
          )}

          {block.type === "calendar" && (
            <>
              {block.title && <SectionTitle>{block.title}</SectionTitle>}
              {block.events.length === 0 ? (
                <EmptyLine>
                  Sin fechas todavía. Añade la primera abajo.
                </EmptyLine>
              ) : (
                <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/40">
                  {[...block.events]
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .map((event) => (
                      <li
                        key={event.id}
                        className="flex items-start gap-3 px-3 py-2.5"
                      >
                        <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatDate(event.date)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">{event.title}</p>
                          {event.detail && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {event.detail}
                            </p>
                          )}
                        </div>
                        {!readOnly && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Eliminar ${event.title}`}
                            onClick={() =>
                              update(block.id, (current) =>
                                current.type === "calendar"
                                  ? {
                                      ...current,
                                      events: current.events.filter(
                                        (entry) => entry.id !== event.id
                                      ),
                                    }
                                  : current
                              )
                            }
                          >
                            <Trash2Icon />
                          </Button>
                        )}
                      </li>
                    ))}
                </ul>
              )}
              {!readOnly && (
                <AddEvent
                  onAdd={(date, title) =>
                    update(block.id, (current) =>
                      current.type === "calendar"
                        ? {
                            ...current,
                            events: [
                              ...current.events,
                              {
                                id: newId("fecha"),
                                date,
                                title,
                              } satisfies CalendarEvent,
                            ],
                          }
                        : current
                    )
                  }
                />
              )}
            </>
          )}

          {block.type === "form" && (
            <>
              {block.title && <SectionTitle>{block.title}</SectionTitle>}
              {block.fields.length === 0 ? (
                <EmptyLine>Este formulario no tiene campos.</EmptyLine>
              ) : (
                <form
                  className="grid gap-3 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const latest = blocksRef.current.find(
                      (item) => item.id === block.id
                    )
                    if (latest) {
                      const pending = timers.current.get(block.id)
                      if (pending) clearTimeout(pending)
                      timers.current.delete(block.id)
                      void send(latest)
                    }
                  }}
                >
                  {block.fields.map((field) => (
                    <div
                      key={field.id}
                      className={
                        field.kind === "textarea"
                          ? "sm:col-span-2"
                          : undefined
                      }
                    >
                      <label
                        htmlFor={`${block.id}-${field.id}`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        {field.label}
                      </label>
                      {field.kind === "textarea" ? (
                        <Textarea
                          id={`${block.id}-${field.id}`}
                          value={field.value}
                          readOnly={readOnly}
                          onChange={(event) => {
                            const value = event.target.value
                            update(
                              block.id,
                              (current) =>
                                current.type === "form"
                                  ? {
                                      ...current,
                                      fields: current.fields.map((entry) =>
                                        entry.id === field.id
                                          ? { ...entry, value }
                                          : entry
                                      ),
                                    }
                                  : current,
                              false
                            )
                          }}
                          className="min-h-20"
                        />
                      ) : field.kind === "select" ? (
                        <select
                          id={`${block.id}-${field.id}`}
                          value={field.value}
                          disabled={readOnly}
                          onChange={(event) => {
                            const value = event.target.value
                            update(block.id, (current) =>
                              current.type === "form"
                                ? {
                                    ...current,
                                    fields: current.fields.map((entry) =>
                                      entry.id === field.id
                                        ? { ...entry, value }
                                        : entry
                                    ),
                                  }
                                : current
                            )
                          }}
                          className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
                        >
                          <option value="">Elige una opción</option>
                          {(field.options ?? []).map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id={`${block.id}-${field.id}`}
                          type={field.kind === "date" ? "date" : "text"}
                          value={field.value}
                          readOnly={readOnly}
                          onChange={(event) => {
                            const value = event.target.value
                            update(
                              block.id,
                              (current) =>
                                current.type === "form"
                                  ? {
                                      ...current,
                                      fields: current.fields.map((entry) =>
                                        entry.id === field.id
                                          ? { ...entry, value }
                                          : entry
                                      ),
                                    }
                                  : current,
                              false
                            )
                          }}
                        />
                      )}
                    </div>
                  ))}
                  {!readOnly && (
                    <div className="sm:col-span-2">
                      <Button type="submit" size="sm">
                        {block.submitLabel ?? "Guardar"}
                      </Button>
                    </div>
                  )}
                </form>
              )}
            </>
          )}

          {block.type === "chart" && (
            <>
              {block.title && <SectionTitle>{block.title}</SectionTitle>}
              {block.series.length === 0 ? (
                <EmptyLine>Sin datos todavía</EmptyLine>
              ) : (
                <ul className="flex flex-col gap-2">
                  {block.series.map((point) => {
                    const max = Math.max(
                      ...block.series.map((entry) => entry.value),
                      1
                    )
                    return (
                      <li
                        key={point.label}
                        className="flex items-center gap-3 text-sm"
                      >
                        <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                          {point.label}
                        </span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-primary/70"
                            style={{
                              width: `${Math.round((point.value / max) * 100)}%`,
                            }}
                          />
                        </span>
                        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {point.value}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </Section>
      ))}
      </div>
    </div>
  )
}

function Section({
  block,
  children,
}: {
  block: PanelBlock
  children: React.ReactNode
}) {
  const framed = !["heading", "text"].includes(block.type)
  if (!framed) return <section>{children}</section>
  return (
    // The border is the panel's own primary colour at 25% alpha, written by
    // appearanceCss — a document can only ever pick a palette id, so there is
    // nothing here that could carry arbitrary CSS.
    <section
      className="rounded-2xl border p-4"
      style={{ borderColor: "var(--panel-border)" }}
    >
      {children}
    </section>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-sm font-medium" style={{ color: "var(--panel-primary)" }}>
      {children}
    </h3>
  )
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

function AddInline({
  placeholder,
  onAdd,
}: {
  placeholder: string
  onAdd: (value: string) => void
}) {
  const [value, setValue] = useState("")

  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const text = value.trim()
        if (!text) return
        onAdd(text)
        setValue("")
      }}
    >
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 max-w-xs"
      />
      <Button type="submit" variant="outline" size="sm" disabled={!value.trim()}>
        <PlusIcon data-icon="inline-start" />
        Añadir
      </Button>
    </form>
  )
}

function AddEvent({ onAdd }: { onAdd: (date: string, title: string) => void }) {
  const [date, setDate] = useState("")
  const [title, setTitle] = useState("")

  return (
    <form
      className="mt-2 flex flex-wrap gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!date || !title.trim()) return
        onAdd(date, title.trim())
        setDate("")
        setTitle("")
      }}
    >
      <Input
        type="date"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        aria-label="Fecha"
        className="h-8 w-40"
      />
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Título"
        aria-label="Título de la fecha"
        className="h-8 max-w-xs"
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={!date || !title.trim()}
      >
        <PlusIcon data-icon="inline-start" />
        Añadir
      </Button>
    </form>
  )
}
