import { auth } from "@clerk/nextjs/server"
import Link from "next/link"
import {
  BugIcon,
  DatabaseIcon,
  GlobeIcon,
  LayersIcon,
  MailIcon,
  MonitorSmartphoneIcon,
  Share2Icon,
  SparklesIcon,
  TimerIcon,
  UserRoundCheckIcon,
} from "lucide-react"

import { AiModelsPanel } from "@/components/ai-models-panel"
import {
  ConnectAccountsPanel,
  SocialAccountsPanel,
} from "@/components/integrations-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { isDeviceOnline, listDevices } from "@/lib/desktop-devices"
import { MODEL_CONFIG, MODEL_LADDERS, type ModelRole } from "@/lib/model"
import { getEnvironmentStatus, type ServiceId } from "@/queries/integrations"

const services: {
  id: ServiceId
  name: string
  role: string
  icon: typeof SparklesIcon
}[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    role: "Interpreta la instrucción, planifica y elige herramientas.",
    icon: SparklesIcon,
  },
  {
    id: "browserbase",
    name: "Browserbase + Playwright",
    role: "Navegador remoto y cada acción con su evidencia.",
    icon: GlobeIcon,
  },
  {
    id: "zernio",
    name: "Zernio",
    role: "16 redes: cuentas, publicaciones, programación y estado.",
    icon: Share2Icon,
  },
  {
    id: "trigger",
    name: "Trigger.dev",
    role: "Tareas duraderas, reintentos y ejecuciones programadas.",
    icon: TimerIcon,
  },
  {
    id: "database",
    name: "PostgreSQL",
    role: "Paneles, historial, permisos y relaciones persistentes.",
    icon: DatabaseIcon,
  },
  {
    id: "clerk",
    name: "Clerk",
    role: "Registro, sesiones y aislamiento por usuario.",
    icon: UserRoundCheckIcon,
  },
  {
    id: "sentry",
    name: "Sentry",
    role: "Errores y trazas de frontend, backend e integraciones.",
    icon: BugIcon,
  },
  {
    id: "resend",
    name: "Resend",
    role: "Correo saliente de los flujos que envían email.",
    icon: MailIcon,
  },
]

// Settings → Integrations. Two different things live here and are shown
// separately: the accounts this person connected (they can connect and
// disconnect them) and the services the operator configured on the server
// (this page only reports whether the variable is present).
export default async function SettingsIntegrationsPage() {
  const { userId } = await auth.protect()

  const status = getEnvironmentStatus()
  const devices = await listDevices(userId)
  const devicesOnline = devices.filter((device) => isDeviceOnline(device)).length
  const configured = Object.values(status).filter(Boolean).length

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="accounts" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="accounts" className="flex items-center gap-2 font-semibold tracking-tight">
            <LayersIcon className="size-4 text-primary" aria-hidden />
            Tus integraciones
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Cuentas conectadas con tu usuario. Godfather solo puede actuar en
            ellas cuando la operación está autorizada; desconectar una cuenta la
            deja fuera de los flujos sin afectar al resto.
          </p>
        </div>

        <div className="rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl">
          <h3 className="font-medium">Redes sociales</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Operaciones internas sobre Zernio: consultar cuentas, preparar
            publicaciones, programar y revisar estados.
          </p>
          <div className="mt-4">
            <SocialAccountsPanel configured={status.zernio} />
          </div>
          <div className="mt-4 border-t border-border/40 pt-4">
            <ConnectAccountsPanel configured={status.zernio} />
          </div>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <MonitorSmartphoneIcon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="flex flex-wrap items-center gap-2 font-medium">
                Desktop Agent
                <Badge variant={devicesOnline > 0 ? "default" : "secondary"}>
                  {devicesOnline > 0
                    ? `${devicesOnline} equipo${devicesOnline === 1 ? "" : "s"} en línea`
                    : devices.length > 0
                      ? "Sin conexión"
                      : "No instalado"}
                </Badge>
              </h3>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                No es un servicio en la nube: es el controlador que instalas en
                tu ordenador. Se instala, vincula y revoca en su propia pestaña.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/settings/desktop-agent" />}
          >
            Gestionar Desktop Agent
          </Button>
        </div>
      </section>

      <section aria-labelledby="services" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              id="services"
              className="flex items-center gap-2 font-semibold tracking-tight"
            >
              <DatabaseIcon className="size-4 text-primary" aria-hidden />
              Servicios del servidor
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Los configura el operador en el servidor. Aquí solo se indica si la
              variable existe: nunca se muestra su valor ni se envía al
              navegador.
            </p>
          </div>
          <Badge variant="outline">
            {configured} de {Object.values(status).length} configurados
          </Badge>
        </div>

        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {services.map((service) => {
            const isConfigured = status[service.id]
            return (
              <li
                key={service.id}
                className="flex items-start gap-3 rounded-2xl border border-border/40 bg-card/50 p-4 backdrop-blur-xl"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <service.icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{service.name}</p>
                    <Badge variant={isConfigured ? "default" : "secondary"}>
                      {isConfigured ? "Configurado" : "Falta la clave"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {service.role}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <AiModelsPanel
        roles={(Object.keys(MODEL_LADDERS) as ModelRole[]).map((role) => ({
          role,
          primary: MODEL_CONFIG[role],
          ladder: MODEL_LADDERS[role],
        }))}
      />

      <section
        aria-labelledby="approvals"
        className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5"
      >
        <h2 id="approvals" className="font-medium">
          Aprobaciones antes de lo sensible
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Publicar, enviar mensajes, borrar información o realizar compras
          requieren confirmación explícita. El modelo solo puede invocar
          herramientas registradas y el backend vuelve a validar cada operación
          antes de ejecutarla.
        </p>
      </section>
    </div>
  )
}
