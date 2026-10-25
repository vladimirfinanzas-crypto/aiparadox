import Link from "next/link"
import {
  ActivityIcon,
  ArrowRightIcon,
  CompassIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  PlugIcon,
  WorkflowIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { LandingHyperspeedBackground } from "@/components/landing-hyperspeed-background"
import { ParadoxLogo } from "@/components/paradox-logo"

// The five experiences the product actually ships. A 404 is the moment someone
// is lost, so instead of a dead end it lists what does exist and what each
// section is for.
const destinations = [
  {
    href: "/chats",
    name: "Agent",
    description:
      "Habla con el agente: pide tareas, revisa el historial y las aprobaciones.",
    icon: MessageSquareIcon,
  },
  {
    href: "/widgets",
    name: "Panels",
    description:
      "Crea interfaces personalizadas con tablas, métricas y planificadores.",
    icon: LayoutDashboardIcon,
  },
  {
    href: "/workflows",
    name: "Automations",
    description:
      "Guarda procesos para repetirlos a mano o con una programación.",
    icon: WorkflowIcon,
  },
  {
    href: "/settings/integrations",
    name: "Integrations",
    description:
      "Conecta cuentas, autoriza servicios y comprueba el estado de las APIs.",
    icon: PlugIcon,
  },
  {
    href: "/settings/activity",
    name: "Activity",
    description:
      "Historial de tareas, pasos ejecutados, resultados y consumo.",
    icon: ActivityIcon,
  },
] as const

export default function NotFoundPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-transparent">
      <LandingHyperspeedBackground />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center gap-10 px-4 py-16 sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
        <section className="rounded-r-2xl bg-background/30 px-4 py-8 backdrop-blur-sm sm:px-6 lg:px-10 lg:py-12">
          <ParadoxLogo
            text="Paradox"
            fillClassName="bg-sky-300"
            className="mb-5 text-5xl font-bold tracking-tight sm:text-6xl"
          />

          <p className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs text-muted-foreground">
            <CompassIcon className="size-3.5" aria-hidden />
            Error 404
          </p>

          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
            <span className="bg-gradient-to-r from-violet-400 via-sky-400 to-cyan-300 bg-clip-text text-transparent">
              Esta ruta no existe.
            </span>
          </h1>

          <p className="mt-4 max-w-xl text-sm text-muted-foreground sm:text-base">
            La dirección no corresponde a ninguna sección de Paradox. Puede ser
            un enlace antiguo o un panel que ya no está. Nada se ha borrado por
            llegar aquí: elige dónde quieres seguir.
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button
              size="lg"
              className="rounded-full"
              render={<Link href="/chats" />}
            >
              Hablar con el agente
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="rounded-full border-border/70 bg-card/60 backdrop-blur-md"
              render={<Link href="/" />}
            >
              Volver al inicio
            </Button>
          </div>

          <p className="mt-4 max-w-md text-xs text-muted-foreground">
            El agente conoce tus paneles, automatizaciones e integraciones: si
            buscabas una herramienta concreta, pídesela y te lleva a ella.
          </p>
        </section>

        <section aria-labelledby="destinations" className="flex flex-col gap-3">
          <h2
            id="destinations"
            className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
          >
            Lo que sí existe
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {destinations.map((destination) => (
              <li key={destination.href}>
                <Link
                  href={destination.href}
                  className="group flex h-full flex-col gap-2 rounded-2xl border border-border/40 bg-card/50 p-4 backdrop-blur-xl transition-colors hover:border-border hover:bg-card/70"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                      <destination.icon className="size-4" aria-hidden />
                    </span>
                    <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="font-medium">{destination.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {destination.description}
                  </span>
                </Link>
              </li>
            ))}

            <li className="rounded-2xl border border-dashed border-border/40 p-4">
              <p className="text-sm font-medium">¿Buscabas otra cosa?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Escríbelo en el chat: el agente puede crear un panel o una
                automatización desde cero.
              </p>
              <Link
                href="/chats"
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Abrir el agente
                <ArrowRightIcon className="size-3" />
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
