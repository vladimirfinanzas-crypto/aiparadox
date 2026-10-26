"use client"

import {
  ArrowDownIcon,
  ArrowUpIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { useState, useTransition } from "react"

import {
  saveProviderSelectionAction,
  testProviderAction,
} from "@/actions/integrations"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type { IntegrationCenter } from "@/queries/integrations"

/**
 * Godfather is the product's AI system, not a vendor: this panel is where the
 * person chooses which of its providers answer, in which order, and proves each
 * one works.
 *
 * The list is the router's own catalogue (`providerConfigurations`), and saving
 * writes the rows the chat task reads before a turn — so this screen and the
 * model layer can never disagree.
 */
export function GodfatherCenter({
  providers,
  selection,
  environmentDisabled,
}: {
  providers: IntegrationCenter["providers"]
  selection: IntegrationCenter["selection"]
  environmentDisabled: string[]
}) {
  const [order, setOrder] = useState<string[]>(selection.order)
  const [disabled, setDisabled] = useState<string[]>(
    selection.disabled.filter((id) => !environmentDisabled.includes(id))
  )
  const [pending, startTransition] = useTransition()
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({})

  // Keyed by string: the saved order is plain text from the database, and a
  // provider that disappeared from the catalogue must simply not render.
  const byId = new Map<string, IntegrationCenter["providers"][number]>(
    providers.map((provider) => [provider.id, provider])
  )
  const dirty =
    order.join(",") !== selection.order.join(",") ||
    [...disabled].sort().join(",") !==
      selection.disabled
        .filter((id) => !environmentDisabled.includes(id))
        .sort()
        .join(",")

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= order.length) return
    const next = [...order]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    setOrder(next)
  }

  const toggle = (provider: string, enabled: boolean) => {
    setDisabled((current) =>
      enabled ? current.filter((id) => id !== provider) : [...new Set([...current, provider])]
    )
  }

  const save = () => {
    startTransition(async () => {
      const result = await saveProviderSelectionAction({ order, disabled })
      if (!result.ok) {
        toast.add({ type: "error", title: "No se guardó", description: result.error })
        return
      }
      setOrder(result.order)
      setDisabled(result.disabled.filter((id) => !environmentDisabled.includes(id)))
      toast.add({
        type: "success",
        title: "Prioridad guardada",
        description: "Godfather usará este orden en tus próximas conversaciones.",
      })
    })
  }

  const test = (provider: string) => {
    setTesting(provider)
    startTransition(async () => {
      try {
        const result = await testProviderAction(provider)
        setResults((current) => ({
          ...current,
          [provider]: { ok: result.ok, message: result.message },
        }))
      } finally {
        setTesting(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {order.map((providerId, index) => {
          const provider = byId.get(providerId)
          if (!provider) return null

          const lockedByServer = environmentDisabled.includes(providerId)
          const enabled = !disabled.includes(providerId)
          const result = results[providerId]

          return (
            <li
              key={providerId}
              className="flex flex-col gap-3 rounded-xl border border-border/40 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-xs font-medium text-primary">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{provider.label}</p>
                    <Badge variant={provider.configured ? "default" : "secondary"}>
                      {provider.configured ? "Clave disponible" : `Falta ${provider.missing.join(", ")}`}
                    </Badge>
                    {lockedByServer && (
                      <Badge variant="outline" title="Desactivado en el servidor">
                        desactivado en el servidor
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{provider.note}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {provider.models.length} modelo{provider.models.length === 1 ? "" : "s"} · cuota por{" "}
                    {provider.quotaUnit}
                  </p>
                  {result && (
                    <p
                      className={cn(
                        "mt-1 text-xs",
                        result.ok ? "text-emerald-400" : "text-destructive"
                      )}
                    >
                      {result.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Switch
                  checked={enabled}
                  disabled={lockedByServer || pending}
                  onCheckedChange={(checked: boolean) => toggle(providerId, checked)}
                  aria-label={`Usar ${provider.label} en Godfather`}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Subir ${provider.label}`}
                  disabled={index === 0 || pending}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Bajar ${provider.label}`}
                  disabled={index === order.length - 1 || pending}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!provider.configured || testing === providerId}
                  onClick={() => test(providerId)}
                >
                  {testing === providerId ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                  Probar
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5" aria-hidden />
          Solo se usan proveedores con clave en el servidor; el resto se salta sin error.
        </p>
        <Button size="sm" onClick={save} disabled={!dirty || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
          Guardar prioridad
        </Button>
      </div>
    </div>
  )
}

/** Browserbase: a read-only credential check, run on demand. */
export function BrowserbaseCheck({ configured }: { configured: boolean }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  if (!configured) {
    return (
      <p className="text-xs text-muted-foreground">
        Para conectarlo, define <code className="font-mono">BROWSERBASE_API_KEY</code> y{" "}
        <code className="font-mono">BROWSERBASE_PROJECT_ID</code> en el entorno del despliegue.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const { testBrowserbaseAction } = await import("@/actions/integrations")
            setResult(await testBrowserbaseAction())
          })
        }
      >
        {pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
        Probar conexión
      </Button>
      {result && (
        <p className={cn("text-xs", result.ok ? "text-emerald-400" : "text-destructive")}>
          {result.message}
        </p>
      )}
    </div>
  )
}
