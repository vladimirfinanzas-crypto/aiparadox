"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckIcon } from "lucide-react"
import { toast } from "sonner"

import { updatePanelAppearance } from "@/actions/widget"
import { Spinner } from "@/components/ui/spinner"
import {
  panelColors,
  panelDensities,
  panelLayouts,
  type PanelAppearance,
  type PanelColor,
} from "@/lib/panels/appearance"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The panel look, as data.
//
// Everything a person can pick is an id from lib/panels/appearance: colours
// from the fixed palette, layout and density from their fixed lists. There is
// no colour input and no CSS field anywhere here, so what is stored is always
// something the renderer can turn into its own classes and custom properties.
// ---------------------------------------------------------------------------

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="text-sm font-medium">{label}</span>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Swatches({
  value,
  onChange,
  label,
}: {
  value: PanelColor
  onChange: (next: PanelColor) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {panelColors.map((entry) => {
        const selected = entry.id === value
        return (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={entry.label}
            title={entry.label}
            onClick={() => onChange(entry.id)}
            className={cn(
              "grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-card transition-all",
              selected
                ? "ring-2 ring-foreground/70"
                : "ring-1 ring-border hover:ring-foreground/40"
            )}
            style={{ backgroundColor: entry.hex }}
          >
            {selected && <CheckIcon className="size-3.5 text-white" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (next: T) => void
  options: ReadonlyArray<{ id: T; label: string }>
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex w-fit rounded-lg border border-border/60 bg-card/60 p-0.5"
    >
      {options.map((option) => {
        const selected = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** The three colour rows plus layout and density, without any saving. */
export function AppearanceFields({
  value,
  onChange,
  disabled = false,
}: {
  value: PanelAppearance
  onChange: (next: PanelAppearance) => void
  disabled?: boolean
}) {
  const set = <K extends keyof PanelAppearance>(
    key: K,
    next: PanelAppearance[K]
  ) => onChange({ ...value, [key]: next })

  return (
    <div
      className="flex flex-col gap-5 rounded-2xl border border-border/40 bg-card/40 p-4"
      aria-busy={disabled}
    >
      <Row label="Colores" hint="Tres tonos: el principal, la superficie y los detalles.">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Principal</span>
            <Swatches
              label="Color principal"
              value={value.color}
              onChange={(next) => set("color", next)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Superficie</span>
            <Swatches
              label="Color de superficie"
              value={value.background}
              onChange={(next) => set("background", next)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Acento</span>
            <Swatches
              label="Color de acento"
              value={value.accent}
              onChange={(next) => set("accent", next)}
            />
          </div>
        </div>
      </Row>

      <Row label="Distribución" hint="Cómo se reparten los bloques en el panel.">
        <Segmented
          label="Distribución"
          value={value.layout}
          onChange={(next) => set("layout", next)}
          options={panelLayouts}
        />
      </Row>

      <Row label="Densidad" hint="Cuánto espacio ocupa cada bloque.">
        <Segmented
          label="Densidad"
          value={value.density}
          onChange={(next) => set("density", next)}
          options={panelDensities}
        />
      </Row>
    </div>
  )
}

/**
 * The same fields, saved through the server action instead of held in state.
 * Used on an existing panel, where the look is already stored and only changes.
 */
export function PanelAppearanceForm({
  widgetId,
  value,
}: {
  widgetId: string
  value: PanelAppearance
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const save = (next: PanelAppearance) => {
    const formData = new FormData()
    formData.set("id", widgetId)
    formData.set("color", next.color)
    formData.set("background", next.background)
    formData.set("accent", next.accent)
    formData.set("layout", next.layout)
    formData.set("density", next.density)

    startTransition(async () => {
      try {
        await updatePanelAppearance(formData)
        toast.success("Apariencia guardada")
        router.refresh()
      } catch {
        toast.error("No se pudo guardar la apariencia.")
      }
    })
  }

  return (
    <div className="relative">
      <AppearanceFields value={value} onChange={save} disabled={pending} />
      {pending && (
        <span className="absolute top-3 right-3" aria-hidden>
          <Spinner className="size-4" />
        </span>
      )}
    </div>
  )
}
