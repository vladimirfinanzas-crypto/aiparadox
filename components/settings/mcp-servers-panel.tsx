"use client"

import { useState, useTransition } from "react"
import {
  BlocksIcon,
  CircleAlertIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"

import {
  createMcpServerAction,
  deleteMcpServerAction,
  testMcpServerAction,
  updateMcpServerAction,
} from "@/actions/integrations"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import type { IntegrationCenter } from "@/queries/integrations"

type McpServer = IntegrationCenter["mcp"][number]
type McpAuthType = "none" | "bearer" | "header"

const authLabels: Record<McpAuthType, string> = {
  none: "Sin autenticación",
  bearer: "Bearer token",
  header: "Clave en cabecera (x-api-key)",
}

const statusMeta: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  connected: { label: "Conectado", variant: "default" },
  unverified: { label: "Sin verificar", variant: "secondary" },
  error: { label: "Error de conexión", variant: "destructive" },
}

type FormState = {
  name: string
  url: string
  authType: McpAuthType
  credential: string
  enabled: boolean
}

const emptyForm: FormState = {
  name: "",
  url: "",
  authType: "none",
  credential: "",
  enabled: true,
}

export function McpServersPanel({
  items,
  encryptionAvailable,
}: {
  items: McpServer[]
  encryptionAvailable: boolean
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [pending, startTransition] = useTransition()
  const [testing, setTesting] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)

  const startCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  const startEdit = (item: McpServer) => {
    setEditing(item)
    setForm({
      name: item.name,
      url: item.url,
      authType: (item.authType as McpAuthType) ?? "none",
      credential: "",
      enabled: item.enabled,
    })
    setOpen(true)
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = () => {
    startTransition(async () => {
      const payload = {
        name: form.name,
        url: form.url,
        authType: form.authType,
        credential: form.credential.trim() || undefined,
        enabled: form.enabled,
      }

      const result = editing
        ? await updateMcpServerAction(editing.id, payload)
        : await createMcpServerAction(payload)

      if (!result.ok) {
        toast.add({ type: "error", title: "No se guardó", description: result.error })
        return
      }

      setOpen(false)
      toast.add({
        type: "success",
        title: editing ? "Servidor actualizado" : "Servidor añadido",
        description: "Pulsa «Descubrir herramientas» para hablar con él de verdad.",
      })
    })
  }

  const discover = (item: McpServer) => {
    setTesting(item.id)
    startTransition(async () => {
      try {
        const result = await testMcpServerAction(item.id)
        setMessages((current) => ({
          ...current,
          [item.id]: "error" in result ? result.error : result.message,
        }))
      } finally {
        setTesting(null)
      }
    })
  }

  const toggle = (item: McpServer, enabled: boolean) => {
    // Reuses the update action so an endpoint is never written by a second path.
    startTransition(async () => {
      const result = await updateMcpServerAction(item.id, {
        name: item.name,
        url: item.url,
        authType: item.authType,
        enabled,
      })
      if (!result.ok) {
        toast.add({
          type: "error",
          title: "No se cambió",
          description: result.error,
        })
      }
    })
  }

  const remove = (item: McpServer) => {
    startTransition(async () => {
      const result = await deleteMcpServerAction(item.id)
      setConfirming(null)
      if (!result.ok) {
        toast.add({ type: "error", title: "No se eliminó", description: result.error })
        return
      }
      toast.add({ type: "success", title: `«${item.name}» eliminado` })
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Servidores MCP sobre HTTP. Paradox hace el handshake real
          (<code className="font-mono">initialize</code> +{" "}
          <code className="font-mono">tools/list</code>) y muestra solo las
          herramientas que el servidor publica. Descubrir no es ejecutar: las
          llamadas pasan por el registro de herramientas del agente.
        </p>
        <Button size="sm" onClick={startCreate} disabled={!encryptionAvailable}>
          <PlusIcon data-icon="inline-start" />
          Añadir servidor
        </Button>
      </div>

      <p className="flex items-start gap-2 rounded-xl border border-border/40 bg-card/40 p-3 text-xs text-muted-foreground">
        <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Solo transporte HTTP: Paradox corre en la nube y nunca ejecuta un comando
          local por ti. Un servidor <code className="font-mono">stdio</code> hay que
          exponerlo por HTTP para poder usarlo aquí.
        </span>
      </p>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/50 p-6 text-center text-sm text-muted-foreground">
          Ningún servidor MCP configurado.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const meta = statusMeta[item.status] ?? statusMeta.unverified!
            const message = messages[item.id]

            return (
              <li
                key={item.id}
                className="flex flex-col gap-3 rounded-2xl border border-border/40 bg-card/50 p-4 backdrop-blur-xl"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <BlocksIcon className="size-4 text-primary" aria-hidden />
                      {item.name}
                      <Badge variant="outline">{item.transport.toUpperCase()}</Badge>
                      {!item.enabled && <Badge variant="secondary">Desactivado</Badge>}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {item.url}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                    <Switch
                      checked={item.enabled}
                      disabled={pending}
                      onCheckedChange={(checked: boolean) => toggle(item, checked)}
                      aria-label={`Activar ${item.name}`}
                    />
                  </div>
                </div>

                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <KeyRoundIcon className="size-3" aria-hidden />
                  {item.credentialHint
                    ? `Credencial ${item.credentialHint}`
                    : "Sin credencial guardada"}
                  {" · "}
                  {item.tools.length} herramienta{item.tools.length === 1 ? "" : "s"} descubierta
                  {item.tools.length === 1 ? "" : "s"}
                </p>

                {item.tools.length > 0 && (
                  <ul className="flex flex-wrap gap-1">
                    {item.tools.map((tool) => (
                      <li
                        key={tool.name}
                        title={tool.description}
                        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground"
                      >
                        {tool.name}
                      </li>
                    ))}
                  </ul>
                )}

                {message && <p className="text-xs text-muted-foreground">{message}</p>}
                {item.lastError && !message && (
                  <p className="text-xs text-destructive">{item.lastError}</p>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={testing === item.id}
                    onClick={() => discover(item)}
                  >
                    {testing === item.id ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <RefreshCwIcon data-icon="inline-start" />
                    )}
                    Descubrir herramientas
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => startEdit(item)}>
                    <PencilIcon data-icon="inline-start" />
                    Editar
                  </Button>
                  {confirming === item.id ? (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={pending}
                        onClick={() => remove(item)}
                      >
                        Confirmar borrado
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirming(null)}
                      >
                        Cancelar
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => setConfirming(item.id)}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      Eliminar
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BlocksIcon className="size-4 text-primary" aria-hidden />
              {editing ? `Editar ${editing.name}` : "Añadir un servidor MCP"}
            </DialogTitle>
            <DialogDescription>
              La URL se valida contra la red real (sin hosts internos). La
              credencial se cifra antes de guardarse y no vuelve a mostrarse.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-name">Nombre</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Mi servidor MCP"
                maxLength={60}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="mcp-url">URL del endpoint</Label>
              <Input
                id="mcp-url"
                value={form.url}
                onChange={(event) => set("url", event.target.value)}
                placeholder="https://mcp.ejemplo.com/mcp"
                inputMode="url"
                maxLength={500}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="mcp-auth">Autenticación</Label>
              <NativeSelect
                id="mcp-auth"
                value={form.authType}
                onChange={(event) =>
                  set("authType", event.target.value as McpAuthType)
                }
              >
                {(["none", "bearer", "header"] as const).map((authType) => (
                  <NativeSelectOption key={authType} value={authType}>
                    {authLabels[authType]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            {form.authType !== "none" && (
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-credential">
                  Credencial
                  {editing?.credentialHint && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      (guardada: {editing.credentialHint})
                    </span>
                  )}
                </Label>
                <Input
                  id="mcp-credential"
                  type="password"
                  autoComplete="off"
                  value={form.credential}
                  onChange={(event) => set("credential", event.target.value)}
                  placeholder={editing ? "Déjalo vacío para conservar la actual" : ""}
                  maxLength={600}
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/40 p-3">
              <div>
                <p className="text-sm font-medium">Activo</p>
                <p className="text-xs text-muted-foreground">
                  Un servidor desactivado conserva su configuración pero queda
                  fuera del descubrimiento.
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(checked: boolean) => set("enabled", checked)}
                aria-label="Activar servidor MCP"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {editing ? "Guardar cambios" : "Añadir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
