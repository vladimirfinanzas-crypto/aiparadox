"use client"

import { useState, useTransition } from "react"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  KeyRoundIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"

import {
  createCustomIntegrationAction,
  deleteCustomIntegrationAction,
  testCustomIntegrationAction,
  updateCustomIntegrationAction,
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
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import {
  AUTH_TYPES,
  CATEGORY_LABELS,
  INTEGRATION_CATEGORIES,
  type AuthType,
  type IntegrationCategory,
} from "@/lib/custom-integrations"
import { cn } from "@/lib/utils"
import type { IntegrationCenter } from "@/queries/integrations"

type CustomIntegration = IntegrationCenter["custom"][number]

const authLabels: Record<AuthType, string> = {
  bearer: "Bearer token (Authorization: Bearer …)",
  header: "Clave en cabecera (x-api-key: …)",
  basic: "Basic (usuario:contraseña)",
  none: "Sin autenticación (endpoint público)",
}

// Status is three different facts and the copy says which one it is: fields
// saved, host reached, credential accepted. "configured" never looks connected.
const statusMeta: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  verified: { label: "Verificada", variant: "default" },
  configured: { label: "Configurada, sin verificar", variant: "secondary" },
  error: { label: "Error de conexión", variant: "destructive" },
}

type FormState = {
  name: string
  category: IntegrationCategory
  baseUrl: string
  authType: AuthType
  credential: string
  description: string
  capabilities: string
}

const emptyForm: FormState = {
  name: "",
  category: "api",
  baseUrl: "",
  authType: "bearer",
  credential: "",
  description: "",
  capabilities: "",
}

function formFrom(item: CustomIntegration): FormState {
  return {
    name: item.name,
    category: (item.category as IntegrationCategory) ?? "other",
    baseUrl: item.baseUrl,
    authType: (item.authType as AuthType) ?? "bearer",
    // Never pre-filled: a stored credential is not sent back to the browser.
    credential: "",
    description: item.description ?? "",
    capabilities: item.capabilities.join(", "),
  }
}

export function CustomIntegrationsPanel({
  items,
  encryptionAvailable,
}: {
  items: CustomIntegration[]
  encryptionAvailable: boolean
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<CustomIntegration | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [pending, startTransition] = useTransition()
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)

  const startCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  const startEdit = (item: CustomIntegration) => {
    setEditing(item)
    setForm(formFrom(item))
    setOpen(true)
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = () => {
    startTransition(async () => {
      const payload = {
        name: form.name,
        category: form.category,
        baseUrl: form.baseUrl,
        authType: form.authType,
        credential: form.credential.trim() || undefined,
        description: form.description.trim() || undefined,
        capabilities: form.capabilities
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      }

      const result = editing
        ? await updateCustomIntegrationAction(editing.id, payload)
        : await createCustomIntegrationAction(payload)

      if (!result.ok) {
        toast.add({ type: "error", title: "No se guardó", description: result.error })
        return
      }

      setOpen(false)
      toast.add({
        type: "success",
        title: editing ? "Integración actualizada" : "Integración añadida",
        // Says out loud that saving is not connecting.
        description: "Pulsa «Probar» para comprobar que responde de verdad.",
      })
    })
  }

  const test = (item: CustomIntegration) => {
    setTesting(item.id)
    startTransition(async () => {
      try {
        const result = await testCustomIntegrationAction(item.id)
        setResults((current) => ({
          ...current,
          [item.id]: "error" in result ? result.error : result.message,
        }))
      } finally {
        setTesting(null)
      }
    })
  }

  const remove = (item: CustomIntegration) => {
    startTransition(async () => {
      const result = await deleteCustomIntegrationAction(item.id)
      setConfirming(null)
      if (!result.ok) {
        toast.add({ type: "error", title: "No se eliminó", description: result.error })
        return
      }
      toast.add({ type: "success", title: `«${item.name}» eliminada` })
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Añade una API que no venga de fábrica. Se guarda la configuración y, por
          separado, si el servidor consiguió hablar con ella.
        </p>
        <Button size="sm" onClick={startCreate} disabled={!encryptionAvailable}>
          <PlusIcon data-icon="inline-start" />
          Añadir API
        </Button>
      </div>

      {!encryptionAvailable && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Las credenciales solo se guardan cifradas y falta{" "}
            <code className="font-mono">INTEGRATIONS_ENCRYPTION_KEY</code> en el
            servidor, así que añadir APIs está desactivado. Genera una con{" "}
            <code className="font-mono">openssl rand -base64 32</code> y configúrala
            en el entorno del despliegue.
          </span>
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/50 p-6 text-center text-sm text-muted-foreground">
          Todavía no has añadido ninguna API propia.
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map((item) => {
            const meta = statusMeta[item.status] ?? statusMeta.configured!
            const message = results[item.id]

            return (
              <li
                key={item.id}
                className="flex flex-col gap-3 rounded-2xl border border-border/40 bg-card/50 p-4 backdrop-blur-xl"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {item.name}
                      <Badge variant="outline">
                        {CATEGORY_LABELS[(item.category as IntegrationCategory) ?? "other"]}
                      </Badge>
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {item.baseUrl}
                    </p>
                  </div>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </div>

                {item.description && (
                  <p className="text-xs text-muted-foreground">{item.description}</p>
                )}

                {item.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {item.capabilities.map((capability) => (
                      <span
                        key={capability}
                        className="rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground"
                      >
                        {capability}
                      </span>
                    ))}
                  </div>
                )}

                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <KeyRoundIcon className="size-3" aria-hidden />
                  {item.credentialHint
                    ? `Credencial ${item.credentialHint}`
                    : "Sin credencial guardada"}
                </p>

                {message && (
                  <p
                    className={cn(
                      "flex items-start gap-1.5 text-xs",
                      item.status === "verified" ? "text-emerald-400" : "text-amber-300"
                    )}
                  >
                    <CircleCheckIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {message}
                  </p>
                )}

                {item.lastError && !message && (
                  <p className="text-xs text-destructive">{item.lastError}</p>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={testing === item.id}
                    onClick={() => test(item)}
                  >
                    {testing === item.id ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <RefreshCwIcon data-icon="inline-start" />
                    )}
                    Probar
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
              <PlugZapIcon className="size-4 text-primary" aria-hidden />
              {editing ? `Editar ${editing.name}` : "Añadir una API"}
            </DialogTitle>
            <DialogDescription>
              La URL se comprueba contra la red real: no se admiten hosts internos
              ni direcciones privadas. La credencial se cifra antes de guardarse y
              no vuelve a mostrarse.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ci-name">Nombre</Label>
              <Input
                id="ci-name"
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Mi API de datos"
                maxLength={60}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ci-category">Tipo de integración</Label>
              <NativeSelect
                id="ci-category"
                value={form.category}
                onChange={(event) =>
                  set("category", event.target.value as IntegrationCategory)
                }
              >
                {INTEGRATION_CATEGORIES.map((category) => (
                  <NativeSelectOption key={category} value={category}>
                    {CATEGORY_LABELS[category]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ci-url">URL base</Label>
              <Input
                id="ci-url"
                value={form.baseUrl}
                onChange={(event) => set("baseUrl", event.target.value)}
                placeholder="https://api.ejemplo.com/v1/ping"
                inputMode="url"
                maxLength={500}
              />
              <p className="text-xs text-muted-foreground">
                «Probar» hace un GET a esta URL exacta. Usa un endpoint barato y de
                solo lectura.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ci-auth">Autenticación</Label>
              <NativeSelect
                id="ci-auth"
                value={form.authType}
                onChange={(event) => set("authType", event.target.value as AuthType)}
              >
                {AUTH_TYPES.map((authType) => (
                  <NativeSelectOption key={authType} value={authType}>
                    {authLabels[authType]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            {form.authType !== "none" && (
              <div className="grid gap-1.5">
                <Label htmlFor="ci-credential">
                  Credencial
                  {editing?.credentialHint && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      (guardada: {editing.credentialHint})
                    </span>
                  )}
                </Label>
                <Input
                  id="ci-credential"
                  type="password"
                  autoComplete="off"
                  value={form.credential}
                  onChange={(event) => set("credential", event.target.value)}
                  placeholder={editing ? "Déjalo vacío para conservar la actual" : ""}
                  maxLength={600}
                />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="ci-description">Descripción</Label>
              <Textarea
                id="ci-description"
                value={form.description}
                onChange={(event) => set("description", event.target.value)}
                placeholder="Para qué sirve y cuándo debería usarla Godfather."
                maxLength={300}
                rows={2}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ci-capabilities">Capacidades</Label>
              <Input
                id="ci-capabilities"
                value={form.capabilities}
                onChange={(event) => set("capabilities", event.target.value)}
                placeholder="leer pedidos, consultar stock"
              />
              <p className="text-xs text-muted-foreground">
                Separadas por comas. Es texto descriptivo: nombra lo que la API
                realmente expone, no una promesa de lo que aún no existe.
              </p>
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
