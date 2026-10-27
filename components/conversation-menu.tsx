"use client"

import { useTransition } from "react"
import { useParams, useRouter } from "next/navigation"
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react"

import { deleteConversationAction } from "@/actions/chat"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

// The options menu on one conversation in the sidebar. Deliberately quiet: it
// only appears on hover or keyboard focus, and the one thing it offers is the
// destructive one — which asks first, and only then talks to the server.
export function ConversationMenu({
  chatId,
  label,
}: {
  chatId: string
  label: string
}) {
  const router = useRouter()
  const params = useParams<{ chatId?: string }>()
  const [pending, startTransition] = useTransition()

  const remove = () => {
    // Cancel here changes nothing: the action is never called, the row stays.
    const confirmed = window.confirm(
      `¿Eliminar la conversación «${label}»? Se quitará de tu lista y no podrás volver a abrirla. Esta acción no se puede deshacer.`
    )
    if (!confirmed) return

    startTransition(async () => {
      try {
        const result = await deleteConversationAction(chatId)

        if (!result.ok) {
          // The conversation was not removed, so the list stays as it was
          toast.add({
            type: "error",
            title: "No se pudo eliminar",
            description: result.error,
          })
          return
        }

        toast.add({ type: "success", title: "Conversación eliminada" })

        if (params.chatId === chatId) {
          // We were inside the conversation we just closed: go home, where the
          // next conversation resolves, instead of resting on a dead route.
          router.push("/chats")
        } else {
          // The sidebar is server-rendered; refresh re-reads it without the row
          router.refresh()
        }
      } catch {
        toast.add({
          type: "error",
          title: "No se pudo eliminar",
          description: "Ocurrió un error inesperado. Inténtalo de nuevo.",
        })
      }
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon"
            variant="ghost"
            className="size-6 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-open:opacity-100"
            aria-label={`Opciones de ${label}`}
            disabled={pending}
          />
        }
      >
        {pending ? (
          <Spinner className="size-3.5" />
        ) : (
          <MoreHorizontalIcon className="size-4" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={remove}>
          <Trash2Icon />
          Eliminar conversación
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
