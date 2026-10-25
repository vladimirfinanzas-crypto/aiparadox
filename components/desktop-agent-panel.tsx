"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import {
  DownloadIcon,
  LinkIcon,
  PauseIcon,
  PlayIcon,
  ShieldAlertIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react"

import {
  approveDesktopCode,
  pauseDesktopDevice,
  resumeDesktopDevice,
  revokeDesktopDevice,
} from "@/actions/desktop"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

export type DesktopAgentDevice = {
  id: string
  name: string
  os: string | null
  agentVersion: string | null
  status: string
  online: boolean
  lastSeenAt: string | null
  capabilities: string[]
  createdAt: string
}

export type DesktopAgentJob = {
  id: string
  kind: string
  status: string
  error: string | null
  createdAt: string
}
export type DesktopAgentRelease = {
  version: string
  bytes: number
  sha256: string
  file: string
  channel?: "development" | "production"
  signed?: boolean
  signature?: { status: "unsigned" | "self-signed" | "verified" }, releasedAt: string
}
const capabilityLabels: Record<string, string> = {
  screen: "Captura de pantalla",
  mouse: "Ratón",
  keyboard: "Teclado",
  run: "Comandos permitidos",
  browser: "Navegador local",
}

const jobStatusLabels: Record<string, string> = {
  pending: "En cola",
  claimed: "Ejecutando",
  done: "Completada",
  failed: "Fallida",
}

function statusOf(device: DesktopAgentDevice) {
  if (device.status === "revoked") {
    return { label: "Revocado", variant: "outline" as const }
  }
  if (device.status === "paused") {
    return { label: "Pausado", variant: "secondary" as const }
  }
  if (device.online) return { label: "En línea", variant: "default" as const }
  return { label: "Sin conexión", variant: "secondary" as const }
}

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function DesktopAgentPanel({
  devices,
  jobs,
  release,
  downloadHref = "/api/desktop/download",
  initialCode,
}: {
  devices: DesktopAgentDevice[]
  jobs: DesktopAgentJob[]
  release: DesktopAgentRelease | null
  /** Exact route for this release; a development build carries its own channel. */
  downloadHref?: string
  initialCode: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const run = (
    action: (formData: FormData) => Promise<void>,
    formData: FormData,
    success: string
  ) => {
    startTransition(async () => {
      try {
        await action(formData)
        toast.add({ type: "success", title: success })
        router.refresh()
      } catch (error) {
        toast.add({
          type: "error",
          title: "No se pudo completar la acción",
          description:
            error instanceof Error ? error.message : "Inténtalo de nuevo.",
        })
      }
    })
  }

  const submitCode = (formData: FormData) => {
    const code = String(formData.get("code") ?? "").trim()
    if (!code) {
      toast.add({ type: "error", title: "Escribe el código del agente" })
      return
    }
    run(approveDesktopCode, formData, `Código ${code} aprobado`)
  }

  const deviceAction = (
    action: (formData: FormData) => Promise<void>,
    id: string,
    success: string
  ) => {
    const formData = new FormData()
    formData.set("id", id)
    run(action, formData, success)
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Install */}
      <section
        aria-labelledby="install"
        className="flex flex-col gap-4 rounded-2xl border border-border/40 bg-card/40 p-5"
      >
        <div className="flex flex-col gap-1">
          <h2 id="install" className="font-medium">
            Instalar el agente
          </h2>
          <p className="text-sm text-muted-foreground">
            Windows 10 u 11 · 64 bits. El instalador empaqueta el runtime del
            agente, así que no hay que instalar Python ni Playwright a mano.
          </p>
        </div>

        {release ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button render={<a href={downloadHref} />} >
              <DownloadIcon data-icon="inline-start" />
              Descargar para Windows
            </Button>
            <p className="text-xs text-muted-foreground">
              Versión {release.version} · {megabytes(release.bytes)} ·{" "}
              {new Date(release.releasedAt).toLocaleDateString("es-ES")}
            </p>
            <Badge variant="outline">
              {release.channel === "development"
                ? "Build de desarrollo"
                : "Release oficial"}
            </Badge>
            <Badge variant="outline">
              {release.signature?.status === "verified"
                ? "Firmado"
                : release.signature?.status === "self-signed"
                  ? "Firma de prueba"
                  : "Sin firma · prueba"}
            </Badge>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl border border-dashed border-amber-400/40 bg-amber-400/5 p-4">
            <Button disabled>
              <DownloadIcon data-icon="inline-start" />
              Descarga no disponible todavía
            </Button>
            <p className="text-xs text-muted-foreground">
              Todavía no hay una compilación publicada. La descarga se activará
              sola en cuanto exista un instalador en{" "}
              <code className="font-mono">public/downloads</code> con su
              manifiesto; hasta entonces no hay ningún archivo que ofrecer.
            </p>
          </div>
        )}

        <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">1.</span> Descarga y
            ejecuta el instalador.
          </li>
          <li>
            <span className="font-medium text-foreground">2.</span> Abre Paradox
            Desktop Agent: mostrará un código de 8 caracteres.
          </li>
          <li>
            <span className="font-medium text-foreground">3.</span> Pega ese
            código aquí abajo mientras estás conectado y aprueba el equipo.
          </li>
        </ol>

        {release && release.signature?.status !== "verified" && (
          <p className="text-xs text-amber-300/90">
            {release.signature?.status === "self-signed"
              ? "Esta versión está firmada con un certificado de prueba: Windows no lo reconoce y SmartScreen puede avisar la primera vez."
              : "Esta versión es una build de prueba sin firma de código: Windows puede avisar la primera vez que la ejecuta."}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {["screen", "mouse", "keyboard", "run"].map((capability) => (
            <Badge key={capability} variant="outline">
              {capabilityLabels[capability] ?? capability}
            </Badge>
          ))}
        </div>
      </section>

      {/* Link a device */}
      <section
        aria-labelledby="link"
        className="flex flex-col gap-4 rounded-2xl border border-border/40 bg-card/40 p-5"
      >
        <div className="flex flex-col gap-1">
          <h2 id="link" className="flex items-center gap-2 font-medium">
            <LinkIcon className="size-4 text-primary" aria-hidden />
            Vincular un equipo
          </h2>
          <p className="text-sm text-muted-foreground">
            Introduce el código que muestra el agente. Aprobarlo autoriza a ese
            equipo a ejecutar tareas en tu nombre hasta que lo revoques.
          </p>
        </div>

        <form action={submitCode} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="code">Código del agente</Label>
            <Input
              id="code"
              name="code"
              defaultValue={initialCode}
              placeholder="ABCD2345"
              autoComplete="off"
              spellCheck={false}
              maxLength={12}
              className="font-mono tracking-[0.2em] uppercase"
              required
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <LinkIcon data-icon="inline-start" />
            )}
            Aprobar equipo
          </Button>
        </form>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlertIcon
            className="mt-0.5 size-3.5 shrink-0 text-amber-300"
            aria-hidden
          />
          Si no has abierto el agente, no apruebes ningún código: el código es
          lo único que asocia un equipo a tu cuenta.
        </p>
      </section>

      {/* Devices */}
      <section aria-labelledby="devices" className="flex flex-col gap-3">
        <h2 id="devices" className="font-medium">
          Equipos autorizados
        </h2>

        {devices.length === 0 ? (
          <div className="rounded-2xl border border-dashed p-8 text-center">
            <TerminalIcon className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-2 font-medium">Ningún equipo conectado</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Cuando vincules uno, verás aquí su estado, su versión y lo que ha
              ejecutado.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {devices.map((device) => {
              const status = statusOf(device)
              return (
                <li
                  key={device.id}
                  className="flex flex-col gap-3 rounded-2xl border border-border/40 bg-card/40 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{device.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {device.os ?? "Sistema desconocido"}
                        {device.agentVersion
                          ? ` · agente ${device.agentVersion}`
                          : ""}
                        {device.lastSeenAt
                          ? ` · última conexión ${formatDistanceToNowStrict(
                              new Date(device.lastSeenAt)
                            )} atrás`
                          : " · nunca conectado"}
                      </p>
                    </div>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {device.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline">
                        {capabilityLabels[capability] ?? capability}
                      </Badge>
                    ))}
                  </div>

                  {device.status !== "revoked" && (
                    <div className="flex flex-wrap gap-2 border-t border-border/40 pt-3">
                      {device.status === "paused" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            deviceAction(
                              resumeDesktopDevice,
                              device.id,
                              "Equipo reanudado"
                            )
                          }
                        >
                          <PlayIcon data-icon="inline-start" />
                          Reanudar
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            deviceAction(
                              pauseDesktopDevice,
                              device.id,
                              "Equipo pausado"
                            )
                          }
                        >
                          <PauseIcon data-icon="inline-start" />
                          Pausar
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={pending}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `¿Revocar "${device.name}"? El agente dejará de funcionar inmediatamente.`
                            )
                          ) {
                            return
                          }
                          deviceAction(
                            revokeDesktopDevice,
                            device.id,
                            "Equipo revocado"
                          )
                        }}
                      >
                        <Trash2Icon data-icon="inline-start" />
                        Revocar
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Recent local executions */}
      <section aria-labelledby="history" className="flex flex-col gap-3">
        <h2 id="history" className="font-medium">
          Últimas ejecuciones locales
        </h2>

        {jobs.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Todavía no se ha ejecutado ninguna tarea en tu equipo.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/40 bg-card/40">
            {jobs.map((job) => {
              return (
                <li
                  key={job.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{job.kind}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {job.error ??
                        `${formatDistanceToNowStrict(new Date(job.createdAt))} atrás`}
                    </p>
                  </div>
                  <Badge
                    variant={
                      job.status === "failed"
                        ? "destructive"
                        : job.status === "done"
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {jobStatusLabels[job.status] ?? job.status}
                  </Badge>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}