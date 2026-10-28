import { auth } from "@clerk/nextjs/server"
import { ArrowLeftIcon, PencilIcon, SparklesIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getWidget, updatePanelDetails } from "@/actions/widget"
import { PanelView } from "@/components/panels/panel-view"
import { PanelAppearanceForm } from "@/components/panels/appearance-picker"
import { WidgetActions } from "@/components/widget-actions"
import {
  PanelToolbar,
  type PanelVersionView,
} from "@/components/workspace/panel-toolbar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { readPanelDocument } from "@/lib/panels/document"
import { appearanceOf } from "@/lib/panels/appearance"
import { listWorkspaceVersions } from "@/queries/workspace"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { userId } = await auth()
  if (!userId) return { title: "Panel · Paradox" }

  const { id } = await params
  const widget = await getWidget(id)
  return { title: widget ? `${widget.name} · Paradox` : "Panel · Paradox" }
}

export default async function WidgetPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const { id } = await params

  // getWidget filters by owner, so another account's panel is simply absent
  const widget = await getWidget(id)
  if (!widget) notFound()

  const document = readPanelDocument(widget.config)

  // The history is read with the same owner filter as the panel itself. The
  // dates are formatted here so the client renders exactly these strings.
  const versions: PanelVersionView[] = (await listWorkspaceVersions(userId, id)).map(
    (item) => ({
      version: item.version,
      author: item.author,
      note: item.note,
      blocks: item.blocks,
      summary: item.summary,
      createdAtLabel: new Intl.DateTimeFormat("es-ES", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(item.createdAt),
    })
  )

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div>
        <Link
          href="/widgets"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3" />
          Mis paneles
        </Link>

        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {widget.name}
            </h1>
            {document.description ? (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {document.description}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Panel guardado en tu espacio.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant={widget.isPublished ? "default" : "secondary"}>
                {widget.isPublished ? "Publicado" : "Borrador"}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                Actualizado{" "}
                {new Intl.DateTimeFormat("es-ES", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(widget.updatedAt)}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <PanelToolbar
              panelId={widget.id}
              panelName={widget.name}
              version={widget.version}
              versions={versions}
            />
            <WidgetActions
              id={widget.id}
              name={widget.name}
              isPublished={widget.isPublished}
            />
          </div>
        </div>
      </div>

      {/* Keyed by version: when Godfather's change or a restore lands, the
          runtime remounts with the new layout instead of keeping its old state */}
      <PanelView key={widget.version} widgetId={widget.id} document={document} />

      <details className="rounded-2xl border border-border/40 bg-card/30 p-4">
        <summary className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <PencilIcon className="size-3.5" aria-hidden />
          Ajustes del panel
        </summary>

        <form action={updatePanelDetails} className="mt-4 grid gap-4">
          <input type="hidden" name="id" value={widget.id} />

          <div>
            <label
              htmlFor="panel-name"
              className="mb-1 block text-sm font-medium"
            >
              Nombre
            </label>
            <Input
              id="panel-name"
              name="name"
              defaultValue={widget.name}
              required
              maxLength={100}
            />
          </div>

          <div>
            <label
              htmlFor="panel-description"
              className="mb-1 block text-sm font-medium"
            >
              Para qué sirve
            </label>
            <Textarea
              id="panel-description"
              name="description"
              defaultValue={document.description ?? ""}
              maxLength={400}
              className="min-h-20"
              placeholder="Una línea que explique el panel."
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm">
              Guardar ajustes
            </Button>
            <p className="text-xs text-muted-foreground">
              La estructura se cambia hablando con el agente; los datos que ya
              has guardado no se tocan.
            </p>
          </div>
        </form>

        <div className="mt-5 border-t border-border/40 pt-4">
          <span className="mb-1 block text-sm font-medium">Apariencia</span>
          <p className="mb-3 text-xs text-muted-foreground">
            Colores, distribución y densidad del panel. Se guardan al instante y
            no crean una versión nueva.
          </p>
          <PanelAppearanceForm
            widgetId={widget.id}
            value={appearanceOf(document)}
          />
        </div>

        <p className="mt-4 flex items-center gap-1.5 border-t border-border/40 pt-3 text-[11px] text-muted-foreground">
          <SparklesIcon className="size-3" aria-hidden />
          Usa «Cambiar con Godfather» para añadir una tabla de gastos o reordenar
          las secciones sin salir de este panel.
        </p>
      </details>
    </div>
  )
}
