import Link from "next/link"
import {
  ActivityIcon,
  ArrowRightIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  PlugIcon,
  SearchXIcon,
  WorkflowIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"

const sections = [
  {
    href: "/chats",
    name: "Agent",
    description: "Chat general, historial, tareas y aprobaciones.",
    icon: MessageSquareIcon,
  },
  {
    href: "/widgets",
    name: "Panels",
    description: "Interfaces personalizadas: crear, abrir y editar.",
    icon: LayoutDashboardIcon,
  },
  {
    href: "/workflows",
    name: "Automations",
    description: "Flujos manuales o programados y sus fallos.",
    icon: WorkflowIcon,
  },
  {
    href: "/settings/integrations",
    name: "Integrations",
    description: "Conectar servicios y comprobar su estado.",
    icon: PlugIcon,
  },
  {
    href: "/settings/activity",
    name: "Activity",
    description: "Pasos ejecutados, resultados y consumo.",
    icon: ActivityIcon,
  },
] as const

export default function DashboardNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border/60 bg-card/60 px-3 py-1 text-xs text-muted-foreground">
          <SearchXIcon className="size-3.5" aria-hidden />
          Error 404
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          Esa página no existe en el dashboard
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          La ruta no corresponde a ninguna sección. No se ha eliminado nada:
          elige a dónde quieres ir. El agente también puede ayudarte a
          encontrar la herramienta correcta.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button render={<Link href="/chats" />}>
            Ir al agente
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
          <Button variant="outline" render={<Link href="/widgets" />}>
            Ir a My Workspace
          </Button>
        </div>
      </div>

      <section aria-labelledby="sections" className="flex flex-col gap-3">
        <h2
          id="sections"
          className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
        >
          Secciones disponibles
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className="group flex h-full items-start gap-3 rounded-2xl border border-border/40 bg-card/50 p-4 transition-colors hover:bg-muted/50"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <section.icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{section.name}</span>
                    <ArrowRightIcon className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {section.description}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
