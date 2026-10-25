import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  DownloadIcon,
  MonitorSmartphoneIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  CHANNEL_LABELS,
  getOfferableDownload,
} from "@/lib/desktop-release"

export const metadata: Metadata = {
  title: "Paradox Desktop Agent",
  description:
    "Conecta tu ordenador a Godfather para ejecutar tareas autorizadas en tu navegador y en tus aplicaciones de escritorio.",
}

const capabilities = [
  "Navegar y rellenar formularios en tu propio navegador.",
  "Capturar la pantalla para comprobar el resultado de cada paso.",
  "Mover el ratón y escribir solo cuando la tarea lo requiere.",
  "Ejecutar únicamente las acciones que el backend autoriza.",
]

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Public page: what the agent is and where to get it. The download button only
// appears when a build the manifest can back is published, and it always goes
// through the same permanent route. A development build says so; a missing,
// invalid or hash-mismatched manifest is explained instead of hidden.
export default async function DownloadDesktopPage() {
  const { primary: status, offer } = await getOfferableDownload()
  const release = offer?.release ?? null
  const signature = release?.signature.status

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <Badge variant="outline" className="w-fit">
          <MonitorSmartphoneIcon data-icon="inline-start" />
          Desktop Agent
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight">
          Conecta tu ordenador a Godfather
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Paradox funciona en la nube. El Desktop Agent es un controlador local
          que permite a Godfather realizar tareas autorizadas en tu navegador y
          en tus aplicaciones de escritorio, con tu permiso y bajo tu control.
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-2xl border border-border/40 bg-card/40 p-6">
        {release ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button render={<a href={offer?.href ?? "/api/desktop/download"} />}>
                <DownloadIcon data-icon="inline-start" />
                Descargar para Windows
              </Button>
              <span className="text-xs text-muted-foreground">
                Versión {release.version} · {megabytes(release.bytes)} ·{" "}
                {new Date(release.releasedAt).toLocaleDateString("es-ES")}
              </span>
              <Badge variant="outline">{CHANNEL_LABELS[release.channel]}</Badge>
              <Badge variant="outline">
                {signature === "verified"
                  ? "Firmado"
                  : signature === "self-signed"
                    ? "Firma de prueba (autofirmada)"
                    : "Sin firma · build de prueba"}
              </Badge>
            </div>
            {release.channel === "development" && (
              <p className="text-xs text-amber-300/90">
                Esta es una build de desarrollo, no una release oficial: sirve
                para probar el agente y puede cambiar sin aviso. El servidor al
                que se conecta está indicado al instalarla.
              </p>
            )}
            {signature === "self-signed" && (
              <p className="text-xs text-amber-300/90">
                La firma existe y el archivo se puede verificar, pero el
                certificado es de prueba y Windows no lo reconoce: SmartScreen
                seguirá avisando hasta publicar una build con un certificado de
                confianza. El SHA-256 de abajo sirve para comprobar el archivo.
              </p>
            )}
            {signature === "unsigned" && (
              <p className="text-xs text-amber-300/90">
                Esta compilación no está firmada con un certificado de código:
                Windows puede mostrar un aviso de SmartScreen la primera vez. El
                SHA-256 de abajo sirve para comprobar el archivo.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              SHA-256:{" "}
              <code className="break-all font-mono">{release.sha256}</code>
            </p>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <Button disabled>
              <DownloadIcon data-icon="inline-start" />
              Descarga no disponible todavía
            </Button>
            <p className="text-xs text-muted-foreground">
              {status.state === "invalid"
                ? `El manifiesto publicado no se puede ofrecer: ${status.message}`
                : status.state === "artifact-missing"
                  ? status.message
                  : "No hay ninguna compilación publicada todavía. Cuando se publique un instalador verificado, este botón descargará ese archivo; no hay ningún archivo falso que ofrecer mientras tanto."}
            </p>
          </div>
        )}

        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium">Requisitos</dt>
            <dd className="text-muted-foreground">
              Windows 10 u 11 de 64 bits. El instalador empaqueta el runtime
              del agente: no hay que instalar Python ni Playwright a mano.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Cómo se conecta</dt>
            <dd className="text-muted-foreground">
              El agente consulta Paradox por HTTPS. No abre puertos y nada entra
              en tu equipo desde fuera.
            </dd>
          </div>
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold tracking-tight">Qué puede hacer</h2>
        <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
          {capabilities.map((capability) => (
            <li key={capability} className="flex items-start gap-2">
              <CheckCircle2Icon
                className="mt-0.5 size-4 shrink-0 text-emerald-400"
                aria-hidden
              />
              {capability}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/40 bg-card/40 p-5">
        <p className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheckIcon
            className="mt-0.5 size-4 shrink-0 text-amber-300"
            aria-hidden
          />
          Puedes pausar el agente o revocar el equipo en cualquier momento desde
          Settings → Desktop Agent. Un equipo revocado deja de responder de
          inmediato.
        </p>
        <Button variant="outline" render={<Link href="/settings/desktop-agent" />}>
          Gestionar mis equipos
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </section>
    </div>
  )
}
