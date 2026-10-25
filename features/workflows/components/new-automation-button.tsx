"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { createAutomationAction } from "@/actions/automations"

export function NewAutomationButton({ label = "Nueva automatización" }: { label?: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  return (
    <Button
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          const result = await createAutomationAction()
          if (!result.ok) {
            toast.error("No se pudo crear la automatización.")
            return
          }
          router.push(`/workflows/${result.id}`)
        })
      }}
    >
      {isPending ? <Spinner className="size-4" /> : <PlusIcon />}
      {label}
    </Button>
  )
}
