import type { Stagehand } from "@browserbasehq/stagehand"

import type { NodeType } from "@/features/workflows/nodes/node-registry"
import { act } from "./act"
import { agent } from "./agent"
import { desktopAction } from "./desktop-action"
import { extract } from "./extract"
import { observe } from "./observe"
import { openUrl } from "./open-url"
import { publishSocial } from "./publish-social"
import { sendEmail } from "./send-email"

export type NodeContext = {
  values: Record<string, string>
  getStagehand: () => Promise<Stagehand>
  // The person the workflow belongs to. Blocks that reach an account — social,
  // the desktop — are scoped to them and never to anyone else.
  userId: string
}

export type NodeExecutor = (ctx: NodeContext) => Promise<unknown>

// `start`, `condition` and `delay` have no executor on purpose: the engine
// handles them itself (it opens the flow, decides the branch, and waits
// durably), so a block can never pretend to run something that does not exist.
export const nodeExecutors: Partial<Record<NodeType, NodeExecutor>> = {
  "open-url": async ({ values, getStagehand }) =>
    openUrl({ stagehand: await getStagehand(), url: values.url }),
  act: async ({ values, getStagehand }) =>
    act({ stagehand: await getStagehand(), instruction: values.instruction }),
  extract: async ({ values, getStagehand }) =>
    extract({ stagehand: await getStagehand(), instruction: values.instruction }),
  observe: async ({ values, getStagehand }) =>
    observe({ stagehand: await getStagehand(), instruction: values.instruction }),
  agent: async ({ values, getStagehand }) =>
    agent({ stagehand: await getStagehand(), instruction: values.instruction }),
  "send-email": async ({ values }) =>
    sendEmail({ to: values.to, subject: values.subject, body: values.body }),
  "publish-social": async ({ values, userId }) =>
    publishSocial({ userId, values }),
  "desktop-action": async ({ values, userId }) =>
    desktopAction({ userId, values }),
}
