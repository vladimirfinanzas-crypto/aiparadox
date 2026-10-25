# The Tool Registry

Godfather has one interface. Behind it there is one catalogue of tools: `lib/tool-registry.ts`.
Nothing else in the app may hard-code a tool list — a tool exists for the model
by registering it here and exporting it from its group.

## What lives where

| Concern | File |
| --- | --- |
| Tool metadata (integration, permissions, risk, approval, timeout, required env vars) | `lib/tool-registry.ts` |
| Availability: is the integration configured? is a device online? | `lib/tool-registry.ts` → `getToolAvailability`, `describeAvailableTools` |
| The tool definitions themselves | `lib/agent-tools.ts` (browser, desktop, social, email), `lib/sandbox-tools.ts` (Godfather's computer), `lib/workspace-tools.ts` (panels, automations), `lib/handoff-tool.ts` (internal delegation) |
| Execution records: one row per call, `running → completed \| failed` | `lib/tool-executions.ts` |
| Where the groups are assembled for a turn | `trigger/chat.ts` (the `tools` callback) |
| Where availability is told to the model | `trigger/chat.ts` → `buildInstructions(..., toolInfo)` |
| What the person sees | `app/(dashboard)/activity/page.tsx` (per-call history), `app/(dashboard)/integrations/page.tsx` (service status) |
| The AI Gateway (providers, ladders, retries, quotas, cooldowns) | `lib/ai/model-router.ts` + `lib/ai/*`, exposed as `chatModel()` in `lib/model.ts` |
| Long-running work (durable, retried, cancellable) | Trigger.dev chat task, `pc_jobs` queue, automation runs |

## How a turn assembles its tools

1. `trigger/chat.ts` asks the registry which groups are configured
   (`getToolAvailability()`). A group whose key is missing never reaches the model.
2. The group factories build the AI SDK tools; `narrowTools` then drops the
   groups the answering agent does not own (the orchestrator owns all of them).
3. `wrapToolsForExecution` wraps every `execute` so the call is recorded.
4. `describeAvailableTools(userId)` writes the paragraph the model is given:
   what it can use right now, and — for anything missing — that it must say so
   instead of pretending the action ran.

## Adding a new API to Godfather

1. **Write the connector** in `lib/<service>.ts`: read the key from an
   environment variable, validate inputs, normalise the provider's errors into
   messages the model can act on, never log the key.
2. **Export a tool factory** in `lib/agent-tools.ts` using `tool()` from the AI
   SDK with a zod `inputSchema`. Give consequential calls a description that
   makes the model confirm with the person first.
3. **Register the group** in `TOOL_GROUPS` (`lib/tool-registry.ts`): id, label,
   integration, tool names, permissions, risk, `requiresApproval`, `timeoutMs`,
   `requiredEnv`, and `unavailableHint`.
4. **Wire it into `trigger/chat.ts`**: add the factory to `capabilities`,
   gated by `availability.<id>.available`.
5. **Document the variable** in `.env.example`, and show the service on
   `app/(dashboard)/integrations/page.tsx` if the person can see its status.
6. **Add tests** in `lib/__tests__/tool-registry.test.ts` for the group's
   availability, and exercise the connector itself the way it will really be
   called (HTTP, mocked provider or a real sandbox key).

Executions need no extra work: any tool with an `execute` function is recorded
automatically and appears in Activity.

## Rules the registry enforces

- Credentials live only in environment variables or the integration row; they
  are never rendered, logged or sent to the browser.
- A missing key makes the group unavailable; the model is told why, and the
  person is told what to connect. Nothing fakes a success.
- High-risk groups must declare `requiresApproval: true`.
- There is no generic shell, code or database tool for external content to
  reach: the sandbox tools act only on Godfather's own machine, and the desktop
  agent allow-lists the applications it will open.
