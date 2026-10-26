import { auth } from "@clerk/nextjs/server"
import Link from "next/link"
import {
  BlocksIcon,
  BugIcon,
  CircleAlertIcon,
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
import { CustomIntegrationsPanel } from "@/components/settings/custom-integrations-panel"
import {
  BrowserbaseCheck,
  GodfatherCenter,
} from "@/components/settings/godfather-center"
import { McpServersPanel } from "@/components/settings/mcp-servers-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { catalogForRole } from "@/lib/ai/models"
import { isDeviceOnline, listDevices } from "@/lib/desktop-devices"
import { MODEL_CONFIG, MODEL_LADDERS, type ModelRole } from "@/lib/model"
import { getIntegrationCenter } from "@/queries/integrations"

const iconClass = "size-4 text-primary"

/** One card: what it is, whether the server can use it, and what to do next. */
function IntegrationCard({
  id,
  title,
  icon,
  status,
  description,
  capabilities,
  config,
  action,
}: {
  id: string
  title: string
  icon: React.ReactNode
  status: { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
  description: string
  capabilities?: string[]
  config?: string[]
  action?: React.ReactNode
}) {
  return (
    <li
      id={id}
      className="flex flex-col gap-3 rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10">
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="font-medium">{title}</h3>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      {capabilities && capabilities.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {capabilities.map((capability) => (
            <li
              key={capability}
              className="rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground"
            >
              {capability}
            </li>
          ))}
        </ul>
      )}

      {config && config.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Se configura en el servidor:{" "}
          {config.map((name, index) => (
            <span key={name}>
              {index > 0 && ", "}
              <code className="font-mono text-foreground/80">{name}</code>
            </span>
          ))}
        </p>
      )}

      {action}
    </li>
  )
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="font-semibold tracking-tight">
          {title}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

// Settings → Integrations is the single place where Paradox's providers and
// services are configured. It is grouped by what a service *is*, not by who
// added it, and it never shows a secret: a server variable is either present or
// not, a stored credential is a masked hint, and "configured" is kept distinct
// from "a request worked".
export default async function SettingsIntegrationsPage() {
  const { userId } = await auth.protect()

  const [center, devices] = await Promise.all([
    getIntegrationCenter(),
    listDevices(userId),
  ])
  const devicesOnline = devices.filter((device) => isDeviceOnline(device)).length
  const { environment } = center

  const configured = (value: boolean) =>
    value
      ? ({ label: "Configurado", variant: "default" } as const)
      : ({ label: "Falta la clave", variant: "secondary" } as const)

  return (
    <div className="flex flex-col gap-10">
      {!center.tablesReady && (
        <p className="flex items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            La base de datos todavía no tiene las tablas del centro de
            integraciones, así que se muestran los valores por defecto y guardar
            fallará. Aplica las migraciones{" "}
            <code className="font-mono">drizzle/0007_integration_center.sql</code> y{" "}
            <code className="font-mono">drizzle/0008_role_models.sql</code> con{" "}
            <code className="font-mono">scripts/apply-migration.mjs</code>.
          </span>
        </p>
      )}

      {/* ---------------------------------------------------------------- AI */}
      <Section
        id="ai-providers"
        title="Godfather · proveedores de IA"
        description="Godfather es el sistema de IA de Paradox, no un proveedor. Aquí eliges qué proveedores lo alimentan, en qué orden y cuáles se saltan; el chat usa exactamente esta selección antes de cada turno."
      >
        <div className="rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 font-medium">
                <SparklesIcon className={iconClass} aria-hidden />
                Prioridad y estado
              </h3>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                El primero que tenga clave y no esté en enfriamiento responde; si
                falla de forma recuperable, Godfather pasa al siguiente. Desactivar
                uno aquí no borra su configuración.
              </p>
            </div>
            <Badge variant="outline">
              {center.providers.filter((provider) => provider.configured).length} de{" "}
              {center.providers.length} con clave
            </Badge>
          </div>

          <GodfatherCenter
            providers={center.providers}
            selection={center.selection}
            environmentDisabled={center.environmentDisabled}
          />
        </div>

        <AiModelsPanel
          roles={(Object.keys(MODEL_LADDERS) as ModelRole[]).map((role) => ({
            role,
            primary: MODEL_CONFIG[role],
            ladder: MODEL_LADDERS[role],
            // The selectable models are the router's own plan for this person:
            // a model from a provider they disabled can never be chosen.
            candidates: catalogForRole(role, center.selection)
              .slice(0, 12)
              .map((candidate) => ({
                provider: candidate.provider,
                modelId: candidate.modelId,
                label: `${candidate.provider}/${candidate.modelId}`,
              })),
            preference: center.preferences[role] ?? null,
          }))}
        />
      </Section>

      {/* -------------------------------------------------------- automation */}
      <Section
        id="automation"
        title="Navegadores y automatización"
        description="Dónde se ejecutan las acciones: la nube de Paradox o tu propio equipo. Son dos rutas distintas y ninguna sustituye a la otra."
      >
        <ul className="flex flex-col gap-3">
          <IntegrationCard
            id="browserbase"
            title="Browserbase + Playwright"
            icon={<GlobeIcon className={iconClass} aria-hidden />}
            status={configured(environment.browserbase)}
            description="Navegador remoto para abrir páginas, extraer datos y guardar evidencia de cada paso. La comprobación consulta la lista de sesiones: no crea ninguna."
            capabilities={["sesiones remotas", "capturas", "evidencia por paso"]}
            config={["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]}
            action={<BrowserbaseCheck configured={environment.browserbase} />}
          />

          <IntegrationCard
            id="desktop-agent"
            title="Desktop Agent"
            icon={<MonitorSmartphoneIcon className={iconClass} aria-hidden />}
            description="No es un servicio en la nube: es el controlador que instalas en tu ordenador. Se instala, vincula y revoca en su propia pestaña."
            status={
              devicesOnline > 0
                ? { label: `${devicesOnline} en línea`, variant: "default" }
                : { label: devices.length > 0 ? "Sin conexión" : "No instalado", variant: "secondary" }
            }
            action={
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                render={<Link href="/settings/desktop-agent" />}
              >
                Gestionar Desktop Agent
              </Button>
            }
          />
        </ul>
      </Section>

      {/* --------------------------------------------------------------- APIs */}
      <Section
        id="apis"
        title="APIs externas"
        description="Servicios que añades tú. Cada una se guarda con su credencial cifrada, se valida contra la red real y solo se marca verificada cuando responde."
      >
        <CustomIntegrationsPanel
          items={center.custom}
          encryptionAvailable={center.encryptionAvailable}
        />
      </Section>

      {/* ---------------------------------------------------------------- MCP */}
      <Section
        id="mcp"
        title="MCP"
        description="Servidores de herramientas que exponen sus propias capacidades. Paradox descubre lo que publican; no ejecuta comandos locales ni llama herramientas fuera de su registro."
      >
        <McpServersPanel
          items={center.mcp}
          encryptionAvailable={center.encryptionAvailable}
        />
      </Section>

      {/* ------------------------------------------------------ communication */}
      <Section
        id="communication"
        title="Comunicación y correo"
        description="Los canales por los que Paradox habla con otras personas."
      >
        <ul className="grid gap-3 md:grid-cols-2">
          <IntegrationCard
            id="resend"
            title="Resend"
            icon={<MailIcon className={iconClass} aria-hidden />}
            status={configured(environment.resend)}
            description="Correo saliente de los flujos que notifican por email. No se prueba desde aquí a propósito: la comprobación enviaría un mensaje real."
            capabilities={["correo saliente"]}
            config={["RESEND_API_KEY"]}
          />
        </ul>
      </Section>

      {/* ------------------------------------------------------------ social */}
      <Section
        id="social"
        title="Redes sociales"
        description="Zernio gestiona las cuentas conectadas de tu perfil: publicaciones, programación y estado. Solo actúa sobre las cuentas que autorizas aquí."
      >
        <ul className="flex flex-col gap-3">
          <IntegrationCard
            id="zernio"
            title="Zernio"
            icon={<Share2Icon className={iconClass} aria-hidden />}
            status={configured(environment.zernio)}
            description="Cuentas, publicaciones y programación en las redes que conectes. Conectar una red abre la autorización del propio proveedor; Paradox no ve tu contraseña."
            capabilities={["cuentas", "publicaciones", "programación", "estado"]}
            config={["ZERNIO_API_KEY"]}
            action={
              <div className="flex flex-col gap-4">
                <SocialAccountsPanel configured={environment.zernio} />
                <div className="border-t border-border/40 pt-4">
                  <ConnectAccountsPanel configured={environment.zernio} />
                </div>
              </div>
            }
          />
        </ul>
      </Section>

      {/* ------------------------------------------------------------- other */}
      <Section
        id="other"
        title="Otras herramientas"
        description="Infraestructura que sostiene la aplicación. Se configura en el despliegue; esta página solo confirma que la variable existe, nunca su valor."
      >
        <ul className="grid gap-3 md:grid-cols-2">
          <IntegrationCard
            id="trigger"
            title="Trigger.dev"
            icon={<TimerIcon className={iconClass} aria-hidden />}
            status={configured(environment.trigger)}
            description="Ejecuta los turnos del chat y las tareas largas fuera de la función web. Si falta, el navegador no puede iniciar ninguna conversación."
            capabilities={["tareas duraderas", "reintentos", "programaciones"]}
            config={["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"]}
          />

          <IntegrationCard
            id="database"
            title="PostgreSQL · Neon"
            icon={<DatabaseIcon className={iconClass} aria-hidden />}
            status={configured(environment.database)}
            description="Historial, paneles, integraciones y permisos. Cada fila está ligada a tu usuario de Clerk."
            capabilities={["persistencia", "aislamiento por usuario"]}
            config={["DATABASE_URL"]}
          />

          <IntegrationCard
            id="clerk"
            title="Clerk"
            icon={<UserRoundCheckIcon className={iconClass} aria-hidden />}
            status={configured(environment.clerk)}
            description="Registro, sesiones y la identidad con la que se firma cada petición al servidor."
            capabilities={["sesiones", "organizaciones"]}
            config={["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"]}
          />

          <IntegrationCard
            id="sentry"
            title="Sentry"
            icon={<BugIcon className={iconClass} aria-hidden />}
            status={configured(environment.sentry)}
            description="Errores y trazas del frontend, del backend y de las integraciones."
            capabilities={["errores", "trazas", "logs"]}
            config={["NEXT_PUBLIC_SENTRY_DSN"]}
          />

          <IntegrationCard
            id="integration-encryption"
            title="Cifrado de credenciales"
            icon={<BlocksIcon className={iconClass} aria-hidden />}
            status={
              center.encryptionAvailable
                ? { label: "Disponible", variant: "default" }
                : { label: "Sin configurar", variant: "destructive" }
            }
            description="AES-256-GCM para las credenciales que guardas en APIs y MCP. Sin esta clave no se guarda ninguna credencial: no hay fallback en texto plano."
            capabilities={["cifrado en reposo", "máscara tras guardar"]}
            config={["INTEGRATIONS_ENCRYPTION_KEY"]}
          />
        </ul>
      </Section>

      <section
        aria-labelledby="approvals"
        className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5"
      >
        <h2 id="approvals" className="flex items-center gap-2 font-medium">
          <LayersIcon className="size-4 text-emerald-400" aria-hidden />
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
