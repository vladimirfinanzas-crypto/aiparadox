"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { RefreshCwIcon } from "lucide-react"

import { checkModelsAction } from "@/actions/ai-health"
import { saveRoleModelAction } from "@/actions/integrations"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import type { AiHealth } from "@/lib/ai-health"
import type { ModelRole } from "@/lib/model"

const roleLabels: Record<ModelRole, { label: string; job: string }> = {
  general: { label: "Chat general", job: "Conversación, análisis y respuestas" },
  fast: { label: "Navegador", job: "Pasos rápidos de automatización web" },
  code: { label: "Código", job: "Escribir, revisar y corregir código" },
  reasoner: { label: "Razonamiento", job: "Razonamiento en varios pasos" },
  vision: { label: "Visión y escritorio", job: "Pantallas, imágenes y capturas" },
  creative: { label: "Social y creativo", job: "Publicaciones y redacción" },
  evaluator: { label: "Enrutado y decisiones", job: "Elegir agente y validar salida" },
}

// "provider/model:free" reads better as "provider/model" with the tier implied
// by the badge next to it.
function shortId(id: string) {
  return id.replace(/:free$/, "")
}

/** One selectable model for a role, as offered by the router's own catalogue. */
export type RoleCandidate = { provider: string; modelId: string; label: string }

export function AiModelsPanel({
  roles,
}: {
  roles: {
    role: ModelRole
    primary: string
    ladder: string[]
    /** Models this person may choose from, restricted to their enabled providers. */
    candidates: RoleCandidate[]
    preference: { provider: string; modelId: string } | null
  }[]
}) {
  const router = useRouter()
  const [health, setHealth] = useState<AiHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [savingRole, setSavingRole] = useState<ModelRole | null>(null)

  const chooseModel = (role: ModelRole, value: string) => {
    setSavingRole(role)
    startTransition(async () => {
      try {
        const result = await saveRoleModelAction(role, value === "" ? null : value)
        if (!result.ok) {
          toast.add({
            type: "error",
            title: "No se guardó el modelo",
            description: result.error,
          })
          return
        }
        // The panel is rendered by a server component: refresh so the ladder
        // shown is the one the router will actually use.
        router.refresh()
        toast.add({
          type: "success",
          title: value === "" ? "Modelo automático" : "Modelo guardado",
          description:
            value === ""
              ? "Ese rol vuelve a usar la escalera de fallback completa."
              : "Se probará primero ese modelo y el fallback sigue intacto.",
        })
      } finally {
        setSavingRole(null)
      }
    })
  }

  const check = () => {
    setError(null)
    startTransition(async () => {
      try {
        setHealth(await checkModelsAction())
      } catch {
        setError("No se pudieron comprobar los modelos.")
      }
    })
  }

  const probeFor = (id: string) => health?.probes?.find((probe) => probe.id === id)

  return (
    <section
      aria-labelledby="ai-models"
      className="flex flex-col gap-4 rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="ai-models" className="font-semibold tracking-tight">
            Runtime de modelos
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Cada rol usa un modelo y cae al siguiente si el primero tarda o
            falla. La comprobación envía un mensaje mínimo a cada modelo y mide
            cuánto tarda en responder; no consume créditos de pago.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={check} disabled={pending}>
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Comprobar modelos
        </Button>
      </div>

      <ul className="grid gap-3 md:grid-cols-2">
        {roles.map((role) => {
          const meta = roleLabels[role.role]
          const probe = probeFor(role.primary)
          return (
            <li
              key={role.role}
              className="flex flex-col gap-2 rounded-xl border border-border/40 bg-background/40 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{meta.label}</p>
                {probe && (
                  <Badge variant={probe.ok ? "default" : "destructive"}>
                    {probe.ok ? `${probe.ms} ms` : "Sin respuesta"}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{meta.job}</p>

              <div className="flex flex-col gap-1">
                <NativeSelect
                  aria-label={`Modelo principal para ${meta.label}`}
                  value={
                    role.preference
                      ? `${role.preference.provider}:${role.preference.modelId}`
                      : ""
                  }
                  disabled={savingRole === role.role}
                  onChange={(event) => chooseModel(role.role, event.target.value)}
                >
                  <option value="">Automático (escalera completa)</option>
                  {role.candidates.map((candidate) => (
                    <option
                      key={`${candidate.provider}:${candidate.modelId}`}
                      value={`${candidate.provider}:${candidate.modelId}`}
                    >
                      {candidate.label}
                    </option>
                  ))}
                </NativeSelect>
                <p className="text-[0.7rem] text-muted-foreground">
                  {role.preference
                    ? "Tu elección va primero; si falla, siguen los demás modelos del rol."
                    : "El router usa el primero disponible de la escalera."}
                </p>
              </div>

              <ol className="flex flex-col gap-1">
                {role.ladder.map((id, index) => {
                  const rung = probeFor(id)
                  const missing = health?.missing.includes(id)
                  const noTools = health?.withoutTools.includes(id)
                  return (
                    <li
                      key={id}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="text-muted-foreground">
                          {index + 1}.
                        </span>
                        <code className="truncate font-mono">{shortId(id)}</code>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {missing && <Badge variant="secondary">No existe</Badge>}
                        {noTools && <Badge variant="secondary">Sin tools</Badge>}
                        {rung && (
                          <span
                            className={
                              rung.ok
                                ? "text-emerald-400"
                                : "text-destructive"
                            }
                          >
                            {rung.ok ? `${rung.ms} ms` : "falla"}
                          </span>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ol>
              {probe && !probe.ok && probe.error && (
                <p className="text-xs text-destructive">{probe.error}</p>
              )}
            </li>
          )
        })}
      </ul>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {health && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>
            {health.keyConfigured
              ? `Clave visible en el servidor · ${health.catalogueSize ?? 0} modelos en OpenRouter · ${health.probes?.filter((probe) => probe.ok).length ?? 0} de ${health.probes?.length ?? 0} responden.`
              : health.catalogueError}
          </p>
          {health.quota && (
            <p>
              {health.quota.remaining === 0
                ? `Límite diario de modelos gratuitos agotado (${health.quota.used}/${health.quota.limit ?? "?"}). Se restablece a medianoche UTC; 10 créditos en OpenRouter lo suben a 1000 peticiones al día.`
                : `Modelos gratuitos hoy: ${health.quota.used} de ${health.quota.limit ?? "?"} usados.`}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
