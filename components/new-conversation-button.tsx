"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"

import { startAgentChat } from "@/actions/agents"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

// One button, one destination: a brand-new conversation with Godfather. Every
// press creates its own chat with its own id (`fresh: true`), so a new
// conversation can never append to the one the person was reading, and the
// previous one stays intact in the history.
export function NewConversationButton({
  compact = false,
  label = "Nueva conversación",
  size,
}: {
  compact?: boolean
  label?: string
  size?: "sm" | "default"
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const start = () => {
    startTransition(async () => {
      try {
        const chatId = await startAgentChat({ fresh: true })
        router.push(`/chats/${chatId}`)
      } catch (error) {
        toast.add({
          type: "error",
          title: "No se pudo abrir Godfather",
          description:
            error instanceof Error ? error.message : "Inténtalo de nuevo.",
        })
      }
    })
  }

  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Nueva conversación"
        onClick={start}
        disabled={pending}
      >
        {pending ? <Spinner /> : <PlusIcon />}
      </Button>
    )
  }

  return (
    <Button onClick={start} disabled={pending} size={size}>
      {pending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <PlusIcon data-icon="inline-start" />
      )}
      {label}
    </Button>
  )
}
