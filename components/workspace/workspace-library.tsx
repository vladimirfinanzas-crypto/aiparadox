"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import {
  LayoutDashboardIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react"

import { WidgetActions } from "@/components/widget-actions"
import { GodfatherWorkspacePanel } from "@/components/workspace/godfather-workspace-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The Workspace library.
//
// Everything here is a real row: a tool this person created, with its layout
// version, its publication state and the sections it contains. Search and the
// filters work over what the server sent; there are no placeholder cards.
// ---------------------------------------------------------------------------

export type WorkspacePanelView = {
  id: string
  name: string
  description: string | null
  version: number
  isPublished: boolean
  blocks: number
  summary: string
  updatedLabel: string
}

type Filter = "all" | "published" | "draft"

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "published", label: "Publicadas" },
  { id: "draft", label: "Borradores" },
]

export function WorkspaceLibrary({ panels }: { panels: WorkspacePanelView[] }) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [godfatherOpen, setGodfatherOpen] = useState(false)

  const counts = useMemo(
    () => ({
      all: panels.length,
      published: panels.filter((panel) => panel.isPublished).length,
      draft: panels.filter((panel) => !panel.isPublished).length,
    }),
    [panels]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return panels.filter((panel) => {
      if (filter === "published" && !panel.isPublished) return false
      if (filter === "draft" && panel.isPublished) return false
      if (!needle) return true
      return (
        panel.name.toLowerCase().includes(needle) ||
        (panel.description ?? "").toLowerCase().includes(needle) ||
        panel.summary.toLowerCase().includes(needle)
      )
    })
  }, [panels, filter, query])

  // Recent work, taken from the same list the server ordered by last activity.
  const recent = panels.slice(0, 3)

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Workspace</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Tus herramientas: las abres, las usas y guardan lo que escribes.
            Godfather las crea y las cambia aquí mismo, sin salir de esta
            sección.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {counts.all} {counts.all === 1 ? "herramienta" : "herramientas"} ·{" "}
            {counts.published} publicada{counts.published === 1 ? "" : "s"} ·{" "}
            {counts.draft} en borrador
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setGodfatherOpen(true)}>
            <SparklesIcon data-icon="inline-start" />
            Crear con Godfather
          </Button>
          <Button variant="outline" render={<Link href="/widgets/new" />}>
            <PlusIcon data-icon="inline-start" />
            Nueva herramienta
          </Button>
        </div>
      </div>

      {panels.length === 0 ? (
        <Empty className="mt-10 min-h-[50vh] border border-dashed border-border/60">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboardIcon />
            </EmptyMedia>
            <EmptyTitle>Todavía no tienes herramientas</EmptyTitle>
            <EmptyDescription>
              Una herramienta es algo que usas, no un chat más: un seguimiento de
              tareas, un registro de entrenamientos, un calendario de
              publicaciones. Descríbela y Godfather la construye, o empieza desde
              una plantilla.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button onClick={() => setGodfatherOpen(true)}>
              <SparklesIcon data-icon="inline-start" />
              Crear con Godfather
            </Button>
            <Button variant="outline" render={<Link href="/widgets/new" />}>
              <PlusIcon data-icon="inline-start" />
              Usar una plantilla
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {recent.length > 1 && (
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Recientes
              </span>
              {recent.map((panel) => (
                <Link
                  key={panel.id}
                  href={`/widgets/${panel.id}`}
                  className="max-w-56 truncate rounded-full border border-border/50 bg-card/50 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                >
                  {panel.name}
                </Link>
              ))}
            </div>
          )}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por nombre o contenido"
                aria-label="Buscar herramientas"
                className="pl-9"
              />
            </div>
            <div
              role="tablist"
              aria-label="Filtrar herramientas"
              className="flex items-center gap-1 rounded-full border border-border/50 bg-card/40 p-1"
            >
              {filters.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  type="button"
                  aria-selected={filter === item.id}
                  onClick={() => setFilter(item.id)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition-colors",
                    filter === item.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {item.label}
                  <span className="ml-1 tabular-nums opacity-70">{counts[item.id]}</span>
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="mt-8 rounded-2xl border border-dashed border-border/60 p-10 text-center">
              <p className="text-sm font-medium">Ninguna herramienta coincide</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                Prueba con otro nombre o quita el filtro para verlas todas.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setQuery("")
                  setFilter("all")
                }}
              >
                Limpiar búsqueda
              </Button>
            </div>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((panel) => (
                <li
                  key={panel.id}
                  className="flex flex-col gap-3 rounded-2xl border border-border/40 bg-card/50 p-4 backdrop-blur-xl"
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/widgets/${panel.id}`} className="min-w-0 flex-1">
                      <p className="truncate font-medium">{panel.name}</p>
                      <p className="mt-0.5 line-clamp-2 min-h-8 text-xs text-muted-foreground">
                        {panel.description ?? "Sin descripción todavía."}
                      </p>
                    </Link>
                    <WidgetActions
                      id={panel.id}
                      name={panel.name}
                      isPublished={panel.isPublished}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={panel.isPublished ? "default" : "secondary"}>
                      {panel.isPublished ? "Publicada" : "Borrador"}
                    </Badge>
                    <Badge variant="outline">v{panel.version}</Badge>
                    <span className="truncate text-xs text-muted-foreground">
                      {panel.summary}
                    </span>
                  </div>

                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/40 pt-3">
                    <span className="text-[11px] text-muted-foreground">
                      {panel.updatedLabel}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        render={<Link href={`/widgets/${panel.id}/preview`} />}
                      >
                        Vista previa
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        render={<Link href={`/widgets/${panel.id}`} />}
                      >
                        Abrir
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Sheet open={godfatherOpen} onOpenChange={setGodfatherOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Crear con Godfather</SheetTitle>
            <SheetDescription>
              Describe la herramienta. Al aceptarla se guardará en tu Workspace y
              podrás usarla.
            </SheetDescription>
          </SheetHeader>
          <GodfatherWorkspacePanel
            className="min-h-0 flex-1"
            onCreated={() => setGodfatherOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </div>
  )
}
