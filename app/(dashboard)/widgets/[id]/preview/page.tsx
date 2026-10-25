import { auth } from "@clerk/nextjs/server"
import { ArrowLeftIcon, PencilIcon } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getWidget } from "@/actions/widget"
import { PanelView } from "@/components/panels/panel-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { readPanelDocument } from "@/lib/panels/document"

export default async function WidgetPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { isAuthenticated } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const { id } = await params

  const widget = await getWidget(id)
  if (!widget) notFound()

  const document = readPanelDocument(widget.config)

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={`/widgets/${id}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3" />
            {widget.name}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {widget.name}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {widget.isPublished
              ? "Así se ve tu panel. Es de solo lectura: los datos se cambian abriéndolo."
              : "Vista previa de un borrador: solo la ves tú."}
          </p>
          <Badge
            variant={widget.isPublished ? "default" : "secondary"}
            className="mt-2"
          >
            {widget.isPublished ? "Publicado" : "Borrador"}
          </Badge>
        </div>
        <Button render={<Link href={`/widgets/${id}`} />} variant="outline">
          <PencilIcon data-icon="inline-start" />
          Abrir panel
        </Button>
      </div>

      <PanelView widgetId={widget.id} document={document} readOnly />
    </div>
  )
}
