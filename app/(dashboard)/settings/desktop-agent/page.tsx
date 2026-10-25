import { auth } from "@clerk/nextjs/server"
import Link from "next/link"
import { CheckCircle2Icon, MonitorSmartphoneIcon } from "lucide-react"

import { DesktopAgentPanel } from "@/components/desktop-agent-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  isDeviceOnline,
  listDevices,
  recentDeviceJobs,
} from "@/lib/desktop-devices"
import { getOfferableDownload } from "@/lib/desktop-release"

// Settings → Desktop Agent. The only place a device is installed, linked,
// paused or revoked; the status shown here is the device's own heartbeat, not
// a guess from a stored credential.
export default async function DesktopAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const { userId } = await auth.protect()
  const { code } = await searchParams

  const [devices, jobs, download] = await Promise.all([
    listDevices(userId),
    recentDeviceJobs(userId, 8),
    getOfferableDownload(),
  ])
  const release = download.offer?.release ?? null

  const online = devices.filter((device) => isDeviceOnline(device))

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <MonitorSmartphoneIcon className="size-4 text-primary" aria-hidden />
          <h2 className="font-semibold tracking-tight">Desktop Agent</h2>
          {devices.length > 0 ? (
            <Badge variant={online.length > 0 ? "default" : "secondary"}>
              {online.length > 0 ? "En línea" : "Sin conexión"}
            </Badge>
          ) : (
            <Badge variant="outline">No instalado</Badge>
          )}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Conecta tu ordenador a Godfather para que Paradox pueda realizar
          tareas autorizadas en tu navegador y en tus aplicaciones de escritorio.
        </p>
        <p className="flex max-w-2xl items-start gap-2 rounded-xl border border-border/40 bg-card/40 p-3 text-xs text-muted-foreground">
          <CheckCircle2Icon
            className="mt-0.5 size-3.5 shrink-0 text-emerald-400"
            aria-hidden
          />
          El agente no abre puertos ni acepta conexiones entrantes: tu equipo
          consulta Paradox por HTTPS. Cada acción se valida aquí antes de
          ejecutarse y puedes pausarlo o revocarlo en cualquier momento.
        </p>
      </header>

      <DesktopAgentPanel
        devices={devices.map((device) => ({
          id: device.id,
          name: device.name,
          os: device.os,
          agentVersion: device.agentVersion,
          status: device.status,
          online: isDeviceOnline(device),
          lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          capabilities: device.capabilities,
          createdAt: device.createdAt.toISOString(),
        }))}
        jobs={jobs.map((job) => ({
          id: job.id,
          kind: (job.action as { kind?: string } | null)?.kind ?? "action",
          status: job.status,
          error: job.error,
          createdAt: job.createdAt.toISOString(),
        }))}
        release={
          release
            ? {
                version: release.version,
                bytes: release.bytes,
                sha256: release.sha256,
                releasedAt: release.releasedAt,
                file: release.file,
                channel: release.channel,
                signed: release.signed,
                signature: release.signature && {
                  status: release.signature.status,
                },
              }
            : null
        }
        downloadHref={download.offer?.href ?? "/api/desktop/download"}
        initialCode={code ?? ""}
      />

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/40 bg-card/40 p-4">
        <div>
          <h2 className="font-medium">Permisos y seguridad</h2>
          <p className="text-xs text-muted-foreground">
            Qué puede hacer Godfather en tu equipo y qué pide confirmación.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/settings" />}>
          Ver permisos
        </Button>
      </section>
    </div>
  )
}
