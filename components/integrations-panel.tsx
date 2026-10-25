"use client"

import { useState, useTransition } from "react"
import { CheckIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react"

import {
  fetchSocialAccounts,
  pcAgentInstructions,
  socialConnectUrl,
} from "@/actions/integrations"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

// The 16 networks Zernio exposes. Order matters only for readability: the ones
// most people connect first are at the top.
const platforms = [
  "instagram",
  "twitter",
  "linkedin",
  "tiktok",
  "youtube",
  "facebook",
  "threads",
  "bluesky",
  "pinterest",
  "reddit",
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "snapchat",
  "googlebusiness",
] as const

type Account = {
  id: string
  platform: string
  username: string
  active: boolean
}

export function SocialAccountsPanel({ configured }: { configured: boolean }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const load = () => {
    setError(null)
    startTransition(async () => {
      const result = await fetchSocialAccounts()
      setAccounts(result.accounts)
      setError(result.error)
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">Cuentas conectadas</h3>
          <p className="text-sm text-muted-foreground">
            Cada cuenta pertenece a tu perfil de Zernio, nunca a otro usuario.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={pending || !configured}
        >
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Revisar cuentas
        </Button>
      </div>

      {!configured && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          Configura <code className="font-mono text-xs">ZERNIO_API_KEY</code> en
          el servidor para conectar redes. La clave no se expone al navegador.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {error}
        </p>
      )}

      {accounts !== null && !error && (
        accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay cuentas conectadas. Usa «Conectar» abajo.
          </p>
        ) : (
          <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/40">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    @{account.username}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {account.platform}
                  </p>
                </div>
                <Badge variant={account.active ? "default" : "secondary"}>
                  {account.active ? "Activa" : "Inactiva"}
                </Badge>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}

export function ConnectAccountsPanel({ configured }: { configured: boolean }) {
  const [links, setLinks] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = async (platform: string) => {
    setPending(platform)
    setError(null)
    try {
      const result = await socialConnectUrl(platform)
      if (result.error || !result.url) {
        setError(result.error ?? "No se pudo crear el enlace.")
        return
      }
      setLinks((current) => ({ ...current, [platform]: result.url! }))
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "No se pudo crear el enlace."
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-medium">Conectar una red</h3>
        <p className="text-sm text-muted-foreground">
          Abre el enlace y autoriza la cuenta. El agente no puede hacerlo por
          ti: solo prepara la URL correcta para tu perfil.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {error}
        </p>
      )}

      <ul className="flex flex-wrap gap-2">
        {platforms.map((platform) => {
          const href = links[platform]
          return (
            <li key={platform} className="flex items-center gap-1">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
                >
                  {platform}
                  <ExternalLinkIcon className="size-3" />
                </a>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full capitalize"
                  onClick={() => connect(platform)}
                  disabled={pending !== null || !configured}
                >
                  {pending === platform && (
                    <Spinner data-icon="inline-start" />
                  )}
                  {platform}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function PcAgentPanel({ initialStatus }: { initialStatus: string }) {
  const [setup, setSetup] = useState<{
    token: string
    status: string
    command: string
  } | null>(null)
  const [pending, startTransition] = useTransition()
  const [copied, setCopied] = useState(false)

  const reveal = () => {
    startTransition(async () => {
      try {
        setSetup(await pcAgentInstructions())
      } catch (error) {
        toast.add({
          type: "error",
          title: "No se pudo leer el token",
          description:
            error instanceof Error ? error.message : "Inténtalo de nuevo.",
        })
      }
    })
  }

  const copy = async () => {
    if (!setup) return
    await navigator.clipboard.writeText(setup.command)
    setCopied(true)
    toast.add({ type: "success", title: "Comando copiado" })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">Módulo de escritorio (PyAutoGUI)</h3>
          <p className="text-sm text-muted-foreground">
            Opcional. Se instala en el ordenador que quieras controlar y hace
            polling por HTTPS: no abre puertos ni VPN.
          </p>
        </div>
        <Badge variant={initialStatus === "online" ? "default" : "secondary"}>
          {initialStatus === "online" ? "En línea" : "Sin conexión"}
        </Badge>
      </div>

      {setup ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/40 bg-background/60 p-3">
          <p className="text-xs text-muted-foreground">
            Ejecuta esto en tu equipo. El token es tuyo: no lo compartas.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-muted/40 p-2 font-mono text-[11px]">
            {setup.command}
          </pre>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              Copiar comando
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={reveal}
          disabled={pending}
        >
          {pending && <Spinner data-icon="inline-start" />}
          Ver instrucciones y token
        </Button>
      )}
    </div>
  )
}
