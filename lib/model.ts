import type { LanguageModelUsage } from "ai"

import {
  MODEL_CONFIG,
  MODEL_LADDERS,
  modelForAgentKind,
  modelRoleForAgentKind,
  modelRoles,
  type ProviderSelection,
  type RoleModelPreference,
} from "./ai/models"
import { createRoutedModel } from "./ai/model-router"
import type { ModelRole } from "./ai/types"

/**
 * The product's model entry point.
 *
 * Every role and every agent now goes through `lib/ai/model-router.ts`, which
 * walks the provider ladder (OpenRouter → Gemini → Cerebras → Groq → Cloudflare
 * by default), filters by capability, and falls back when a provider's free
 * allowance is spent. This module keeps the names the rest of the app already
 * imports, so the chat task, the router, the agent builder and the dashboard did
 * not have to change.
 *
 * The OpenRouter ids below remain the first rung of each ladder: the existing
 * behaviour is preserved, and the secondary providers only answer when
 * OpenRouter cannot.
 */
export { MODEL_CONFIG, MODEL_LADDERS, modelForAgentKind, modelRoleForAgentKind }
export type { ModelRole }

/** Get an OpenRouter model id from the config by its role. */
export function getFreeModel(agentType: ModelRole): string {
  return MODEL_CONFIG[agentType]
}

/** Every model role available in the config. */
export function getFreeModelTypes(): ModelRole[] {
  return modelRoles()
}

/**
 * The model for one role, with its cross-provider fallback ladder and
 * deadlines. `streamText` and `generateText` take it like any provider model.
 */
export function roleModel(
  role: ModelRole,
  selection?: ProviderSelection,
  /** The model this person chose to lead the role, if any. */
  preference?: RoleModelPreference
) {
  return createRoutedModel({
    role,
    ...(selection && { providerSelection: selection }),
    ...(preference && { modelPreference: preference }),
  })
}

/**
 * The model an agent kind talks to: the chat model for conversation, the fast
 * one for browser steps, the vision one for screen work.
 */
export function chatModel(
  agentKind?: string,
  selection?: ProviderSelection,
  preferences?: Partial<Record<ModelRole, RoleModelPreference>>
) {
  const role = modelRoleForAgentKind(agentKind)
  const preference = preferences?.[role]
  return createRoutedModel({
    role,
    ...(agentKind ? { agentKind } : {}),
    ...(selection && { providerSelection: selection }),
    ...(preference && { modelPreference: preference }),
  })
}

/**
 * The model a structured decision uses (routing, evaluation). It must honour a
 * strict JSON schema, so the router only considers models documented to do so.
 */
export function getRoutingModel(
  selection?: ProviderSelection,
  preferences?: Partial<Record<ModelRole, RoleModelPreference>>
) {
  const preference = preferences?.evaluator
  return createRoutedModel({
    role: "evaluator",
    ...(selection && { providerSelection: selection }),
    ...(preference && { modelPreference: preference }),
  })
}

/**
 * The chat model with a strict JSON contract, used to draft agents. Chat turns
 * themselves do not require structured output, which keeps tools-only models
 * (such as Workers AI) eligible for conversation.
 */
export function structuredChatModel(
  agentKind?: string,
  selection?: ProviderSelection,
  preferences?: Partial<Record<ModelRole, RoleModelPreference>>
) {
  const role = modelRoleForAgentKind(agentKind)
  const preference = preferences?.[role]
  return createRoutedModel({
    role,
    requirements: { structuredOutput: true },
    ...(agentKind ? { agentKind } : {}),
    ...(selection && { providerSelection: selection }),
    ...(preference && { modelPreference: preference }),
  })
}

/** The routing model's preferred id, for logs and diagnostics. */
export const ROUTING_MODEL = MODEL_CONFIG.evaluator

// Dollars per million tokens. Every catalogued model is on a free tier, so a
// call costs nothing; the hook stays so a paid backstop can be priced in one
// place if an operator configures one.
const pricing = { input: 0, output: 0 }

// What a call to the chat model cost, in millionths of a dollar
export function chatModelCost(usage: LanguageModelUsage) {
  void usage
  void pricing
  return 0
}
