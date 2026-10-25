import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { Editor } from "@/features/workflows/components/editor"
import { emptyDefinition } from "@/lib/automations/definition"
import { getAutomationDetail, listRunViews } from "@/queries/automations"

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await auth.protect()

  const [{ userId }, { id }] = await Promise.all([auth(), params])
  if (!userId) notFound()

  const detail = await getAutomationDetail(userId, id)
  if (!detail) notFound()

  const { automation } = detail
  const definition =
    automation.definition ?? emptyDefinition(automation.name, automation.timezone)

  const runs = await listRunViews({ userId, workflowId: id, limit: 10 })

  return (
    <Editor
      automationId={automation.id}
      initialDefinition={definition}
      initialStatus={automation.status}
      initialVersion={automation.version}
      runs={runs}
    />
  )
}
