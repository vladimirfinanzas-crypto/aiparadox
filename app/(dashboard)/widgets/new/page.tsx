"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, CheckIcon, PlusIcon, SparklesIcon } from "lucide-react"

import { createWorkspaceFromProposalAction } from "@/actions/workspace"
import { AppearanceFields } from "@/components/panels/appearance-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { createDocument } from "@/lib/panels/document"
import { DEFAULT_APPEARANCE, type PanelAppearance } from "@/lib/panels/appearance"
import { panelTemplates } from "@/lib/panels/templates"

export default function NewWidgetPage() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [templateId, setTemplateId] = useState(panelTemplates[0].id)
  const [name, setName] = useState(panelTemplates[0].name)
  const [purpose, setPurpose] = useState(
    panelTemplates[0].document.description ?? ""
  )
  const [appearance, setAppearance] = useState<PanelAppearance>(DEFAULT_APPEARANCE)
  const [error, setError] = useState<string | null>(null)

  const template =
    panelTemplates.find((item) => item.id === templateId) ?? panelTemplates[0]

  const choose = (id: string) => {
    const next = panelTemplates.find((item) => item.id === id)
    if (!next) return
    setTemplateId(next.id)
    setName(next.name)
    setPurpose(next.document.description ?? "")
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)

    const trimmed = name.trim()
    if (!trimmed) {
      setError("Ponle un nombre al panel.")
      return
    }

    const config = createDocument({
      description: purpose,
      appearance,
      blocks: template.document.blocks,
    })

    startTransition(async () => {
      // The same creation path as the library and Godfather, so the panel is
      // born with its first version frozen and can be reverted later.
      const result = await createWorkspaceFromProposalAction({
        name: trimmed,
        proposal: config,
      })

      if (!result.ok) {
        setError(result.error)
        return
      }

      router.push(`/widgets/${result.panelId}`)
    })
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <Link
        href="/widgets"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3" />
        Mis paneles
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Crear un panel
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Un panel es una herramienta que vive en tu espacio: la abres, la usas y
        guarda lo que escribes. Elige un punto de partida y ajústalo después.
      </p>

      <fieldset className="mt-6">
        <legend className="mb-2 text-sm font-medium">Punto de partida</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {panelTemplates.map((item) => {
            const selected = item.id === templateId
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => choose(item.id)}
                aria-pressed={selected}
                className={
                  selected
                    ? "rounded-2xl border border-primary/50 bg-primary/5 p-4 text-left ring-1 ring-primary/20"
                    : "rounded-2xl border border-border/40 bg-card/40 p-4 text-left transition-colors hover:border-border hover:bg-muted/40"
                }
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{item.name}</span>
                  {selected && (
                    <CheckIcon className="size-3.5 text-primary" aria-hidden />
                  )}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {item.description}
                </span>
              </button>
            )
          })}
        </div>
      </fieldset>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {error}
        </p>
      )}

      <form onSubmit={submit} className="mt-6 grid gap-4">
        <div>
          <label htmlFor="panel-name" className="mb-1 block text-sm font-medium">
            Nombre
          </label>
          <Input
            id="panel-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Entrenamiento"
            autoComplete="off"
            maxLength={100}
            disabled={pending}
            required
          />
        </div>

        <div>
          <label
            htmlFor="panel-purpose"
            className="mb-1 block text-sm font-medium"
          >
            Para qué sirve
          </label>
          <Textarea
            id="panel-purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="Una línea que explique el panel."
            className="min-h-20"
            maxLength={400}
            disabled={pending}
          />
        </div>

        <div>
          <span className="mb-2 block text-sm font-medium">Apariencia</span>
          <p className="mb-2 -mt-1 text-xs text-muted-foreground">
            Colores, distribución y densidad. Puedes cambiarlos después desde el
            panel.
          </p>
          <AppearanceFields
            value={appearance}
            onChange={setAppearance}
            disabled={pending}
          />
        </div>

        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
          <Button type="submit" disabled={pending} className="flex-1">
            {pending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Crear panel
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            render={<Link href="/widgets" />}
          >
            Cancelar
          </Button>
        </div>
      </form>

      <p className="mt-6 flex items-start gap-2 rounded-2xl border border-border/40 bg-card/30 p-4 text-xs text-muted-foreground">
        <SparklesIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          ¿Prefieres describirlo? En{" "}
          <Link href="/widgets" className="font-medium text-primary hover:underline">
            Workspace
          </Link>{" "}
          pulsa «Crear con Godfather» y pide «un panel para…». Lo construye ahí
          mismo y lo guarda en tu lista.
        </span>
      </p>
    </div>
  )
}
