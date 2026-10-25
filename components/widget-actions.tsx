"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  MoreHorizontalIcon,
  Trash2Icon,
} from "lucide-react"

import {
  deleteWidget,
  disableWidget,
  duplicateWidget,
  publishWidget,
} from "@/actions/widget"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

// Server actions that navigate throw a redirect signal; treating it as a failure
// would show an error for an action that in fact succeeded.
function isRedirect(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  )
}

export function WidgetActions({
  id,
  name,
  isPublished,
}: {
  id: string
  name: string
  isPublished: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const run = (action: (formData: FormData) => Promise<void>) => {
    const formData = new FormData()
    formData.set("id", id)

    startTransition(async () => {
      try {
        await action(formData)
        router.refresh()
        toast.add({
          type: "success",
          title: isPublished ? `${name} desactivado` : `${name} publicado`,
        })
      } catch (error) {
        toast.add({
          type: "error",
          title: "No se pudo actualizar el panel",
          description:
            error instanceof Error ? error.message : "Inténtalo de nuevo.",
        })
      }
    })
  }

  const duplicate = () => {
    const formData = new FormData()
    formData.set("id", id)

    startTransition(async () => {
      try {
        // The action redirects to the copy
        await duplicateWidget(formData)
      } catch (error) {
        if (isRedirect(error)) return
        toast.add({
          type: "error",
          title: "No se pudo duplicar el panel",
          description:
            error instanceof Error ? error.message : "Inténtalo de nuevo.",
        })
      }
    })
  }

  const remove = () => {
    if (!window.confirm(`¿Eliminar «${name}»? Esta acción no se deshace.`)) {
      return
    }
    const formData = new FormData()
    formData.set("id", id)

    startTransition(async () => {
      try {
        await deleteWidget(formData)
      } catch (error) {
        if (isRedirect(error)) return
        toast.add({
          type: "error",
          title: "No se pudo eliminar el panel",
          description:
            error instanceof Error ? error.message : "Inténtalo de nuevo.",
        })
      }
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Acciones de ${name}`}
            disabled={pending}
          />
        }
      >
        {pending ? <Spinner /> : <MoreHorizontalIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => run(isPublished ? disableWidget : publishWidget)}
        >
          {isPublished ? (
            <EyeOffIcon data-icon="inline-start" />
          ) : (
            <EyeIcon data-icon="inline-start" />
          )}
          {isPublished ? "Desactivar" : "Publicar"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={duplicate}>
          <CopyIcon data-icon="inline-start" />
          Duplicar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={remove}
        >
          <Trash2Icon data-icon="inline-start" />
          Eliminar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
