import { auth, currentUser } from "@clerk/nextjs/server"
import Link from "next/link"
import {
  BadgeCheckIcon,
  GlobeIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { LocaleSwitcher } from "@/components/locale-switcher"
import { ThemeSwitcher } from "@/components/settings/theme-switcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PAYWALL_ENABLED } from "@/lib/billing"
import { getLocale } from "@/lib/i18n.server"

const permissions = [
  {
    title: "Sandbox y archivos",
    detail: "bash, lectura/escritura y memoria entre conversaciones.",
  },
  {
    title: "Navegador remoto",
    detail: "Playwright sobre Browserbase, con evidencia de cada paso.",
  },
  {
    title: "Escritorio local",
    detail: "PyAutoGUI en tu equipo, por cola de trabajos y token propio.",
  },
  {
    title: "Redes sociales",
    detail: "Zernio: cuentas por id, publicar, programar y consultar estado.",
  },
]

const approvals = [
  "Publicar o programar contenido",
  "Enviar mensajes en tu nombre",
  "Borrar archivos o datos",
  "Compras y cambios de configuración",
]

// Settings → General. Only settings that really exist: the profile Clerk owns,
// the locale the app reads, the appearance the provider applies, the plan the
// billing flag reports and the permissions the tool registry enforces.
export default async function SettingsGeneralPage() {
  const { userId } = await auth.protect()
  const [user, locale] = await Promise.all([currentUser(), getLocale()])

  const email = user?.primaryEmailAddress?.emailAddress
  const name = user?.fullName ?? user?.username ?? "Tu cuenta"

  return (
    <div className="flex flex-col gap-5">
      <section
        aria-labelledby="profile"
        className="rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl"
      >
        <h2 id="profile" className="font-semibold tracking-tight">
          Perfil
        </h2>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {user?.imageUrl ? (
            // Clerk hosts the avatar; it is shown as-is, without optimisation.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.imageUrl}
              alt=""
              width={48}
              height={48}
              className="size-12 rounded-full border border-border/60"
            />
          ) : (
            <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
              <BadgeCheckIcon className="size-5" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-medium">{name}</p>
            <p className="truncate text-sm text-muted-foreground">
              {email ?? "Sin correo principal"}
            </p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {userId}
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-5 md:grid-cols-2">
        <section
          aria-labelledby="preferences"
          className="rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl"
        >
          <h2
            id="preferences"
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <SlidersHorizontalIcon className="size-4 text-primary" aria-hidden />
            Interfaz
          </h2>

          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Apariencia</p>
                <p className="text-xs text-muted-foreground">
                  Se guarda en este navegador y se aplica a toda la aplicación.
                </p>
              </div>
              <ThemeSwitcher />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
              <div>
                <p className="text-sm font-medium">Idioma</p>
                <p className="text-xs text-muted-foreground">
                  Se guarda en la cookie de la sesión.
                </p>
              </div>
              <LocaleSwitcher current={locale} />
            </div>
          </div>
        </section>

        <section
          aria-labelledby="plan"
          className="rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl"
        >
          <h2
            id="plan"
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <GlobeIcon className="size-4 text-primary" aria-hidden />
            Plan y créditos
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">
            {PAYWALL_ENABLED
              ? "Los agentes y sus sandboxes forman parte del plan de pago."
              : "En esta versión de prueba el cobro está desactivado: todo está desbloqueado."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" render={<Link href="/usage" />}>
              Ver consumo
            </Button>
            <Button variant="outline" size="sm" render={<Link href="/pricing" />}>
              Ver planes
            </Button>
          </div>
        </section>
      </div>

      <section
        aria-labelledby="permissions"
        className="rounded-2xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl"
      >
        <h2
          id="permissions"
          className="flex items-center gap-2 font-semibold tracking-tight"
        >
          <ShieldCheckIcon className="size-4 text-emerald-300" aria-hidden />
          Permisos del agente
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          El registro de herramientas decide qué puede invocar cada tipo de
          agente. El backend valida la propuesta antes de ejecutarla.
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {permissions.map((permission) => (
            <li
              key={permission.title}
              className="rounded-xl border border-border/40 p-3"
            >
              <p className="text-sm font-medium">{permission.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {permission.detail}
              </p>
            </li>
          ))}
        </ul>

        <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
          <p className="text-sm font-medium">Requiere aprobación</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {approvals.map((approval) => (
              <li key={approval}>
                <Badge variant="secondary">{approval}</Badge>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}
