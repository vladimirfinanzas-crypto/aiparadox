"use client"

import { useChat } from "@ai-sdk/react"
import * as Sentry from "@sentry/nextjs"
import type { TriggerChatTransport } from "@trigger.dev/sdk/chat"
import {
  useLoadTranscript,
  useTriggerChatTransport,
} from "@trigger.dev/sdk/chat/react"
import { isToolUIPart } from "ai"
import { LayoutDashboardIcon, PaperclipIcon, XIcon } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"

import {
  loadTranscript,
  mintChatAccessToken,
  startChatSession,
} from "@/actions/chat"
// A pure message classifier: it reads the sentence the router writes, so the
// browser does not have to import the router (or its providers) to explain it.
import { aiFailureCodeOf } from "@/lib/ai/fallback"

import { ChatAvatar } from "@/components/chat-avatar"
import { ExecutionEnvironmentCard } from "@/components/execution-environment-card"
import LatticeLoader from "@/components/LatticeLoader"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CodeBlock } from "@/components/ai-elements/code-block"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Image } from "@/components/ai-elements/image"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool"
import { Badge } from "@/components/ui/badge"
import { toast } from "@/components/ui/toast"
import type { Bot } from "@/db/schema"
import { USAGE_LIMIT_ERROR } from "@/lib/billing"
import { usePaywall } from "@/hooks/use-paywall"
import type { ChatUIMessage } from "@/lib/sandbox-tools"
import type { chatAgent } from "@/trigger/chat"

type ChatBot = Pick<Bot, "id" | "name" | "avatar">

// How long a sent message may sit with no stream at all before it is reported
// as never picked up. Long enough for a cold worker to boot, short enough that
// an outage is not mistaken for a slow answer.
const SUBMITTED_TIMEOUT_MS = 45_000

// The compact empty state of a fresh conversation: a question, one line of
// what Godfather can do, and a handful of real shortcuts. It reuses the
// content the old welcome screen carried, inside the chat itself — the chat,
// not a page in front of it, is what the person lands on.
const EMPTY_STATE_QUESTION = "¿Qué quieres conseguir hoy?"
const EMPTY_STATE_SUBTITLE =
  "Pídele una tarea, una herramienta o una automatización: él decide cómo hacerla y te devuelve el resultado."
const SUGGESTIONS = [
  "Crear un calendario de contenidos.",
  "Investigar a la competencia.",
  "Construir un panel para gestionar proyectos.",
  "Automatizar un informe semanal.",
] as const

// The unsent draft is kept between conversations (a new chat, or a switch to
// another one must not swallow what the person was still writing). It is a
// preference, so it lives in sessionStorage — never a substitute for the
// conversation history, which stays on the server.
const DRAFT_KEY = "paradox.chat.draft"

type ToolPart = Extract<
  ChatUIMessage["parts"][number],
  { type: `tool-${string}` }
>

const toolTitles: Record<ToolPart["type"], string> = {
  "tool-bash": "Run command",
  "tool-readFile": "Read file",
  "tool-writeFile": "Write file",
  "tool-listFiles": "List files",
  "tool-recall": "Recall",
  "tool-remember": "Remember",
  "tool-mouseClick": "Click",
  "tool-mouseMove": "Move mouse",
  "tool-mouseDrag": "Drag",
  "tool-mouseScroll": "Scroll",
  "tool-keyboardType": "Type",
  "tool-keyboardPress": "Press key",
  "tool-viewScreen": "Look at screen",
  "tool-showScreen": "Show screen",
  "tool-browser_navigate": "Open page",
  "tool-browser_read": "Read page",
  "tool-browser_click": "Click page",
  "tool-browser_type": "Type on page",
  "tool-browser_press": "Press key",
  "tool-browser_back": "Go back",
  "tool-browser_tabs": "List tabs",
  "tool-browser_select_tab": "Switch tab",
  "tool-browser_screenshot": "Look at page",
  "tool-request_execution_environment": "Where to run it",
  "tool-pc_screenshot": "Look at screen",
  "tool-pc_move": "Move mouse",
  "tool-pc_click": "Click",
  "tool-pc_type": "Type",
  "tool-pc_press": "Press key",
  "tool-pc_hotkey": "Shortcut",
  "tool-pc_scroll": "Scroll",
  "tool-pc_run": "Run program",
  "tool-pc_setup": "Connect a computer",
  "tool-social_accounts": "List accounts",
  "tool-social_connect": "Connect account",
  "tool-social_publish": "Create post",
  "tool-social_status": "Check post",
  "tool-panel_list": "List panels",
  "tool-panel_get": "Read panel",
  "tool-panel_create": "Create panel",
  "tool-panel_update": "Update panel",
  "tool-live_tasks": "Live tasks",
  "tool-panel_versions": "Panel history",
  "tool-panel_publish": "Publish panel",
  "tool-automation_list": "List automations",
  "tool-automation_get": "Read automation",
  "tool-automation_create": "Create automation",
  "tool-automation_update_definition": "Build automation",
  "tool-automation_validate": "Validate automation",
  "tool-automation_run": "Run automation",
  "tool-handoff": "Hand off",
}

// Screenshots — only the ones the agent took to show the reader. The shots it
// takes to see the page or the screen itself stay in the tool panel: they are
// its eyes, not the answer, and a failed one used to leave an empty white card
// over the conversation.
function isShownScreenshot(
  part: ToolPart
): part is Extract<ToolPart, { type: "tool-showScreen" }> {
  return part.type === "tool-showScreen"
}

function ToolCall({ part }: { part: ToolPart }) {
  // These tools' results are for the reader: show the picture, not the call.
  // A screenshot without pixels would render as a broken image, so it falls
  // through to the plain tool line instead.
  if (
    isShownScreenshot(part) &&
    part.state === "output-available" &&
    Boolean(part.output.base64)
  ) {
    return (
      <Image
        alt="A screenshot"
        base64={part.output.base64}
        className="border"
        mediaType={part.output.mediaType}
      />
    )
  }

  // The teammate's reply follows right below, so one line is enough
  if (part.type === "tool-handoff" && part.state === "output-available") {
    return (
      <p className="text-muted-foreground">Handed off to {part.output.name}</p>
    )
  }

  return (
    <Tool>
      <ToolHeader
        state={part.state}
        title={toolTitles[part.type]}
        type={part.type}
      />
      <ToolContent>
        <ToolCallDetails part={part} />
      </ToolContent>
    </Tool>
  )
}

// A created or changed panel is the point of the call, so its result offers the
// panel itself rather than a JSON dump.
function panelResult(output: unknown): { name: string; path: string } | null {
  if (typeof output !== "object" || output === null) return null
  const record = output as Record<string, unknown>
  return typeof record.path === "string" && typeof record.name === "string"
    ? { name: record.name, path: record.path }
    : null
}

function ToolCallDetails({ part }: { part: ToolPart }) {
  const error = part.state === "output-error" ? part.errorText : undefined

  if (part.type === "tool-panel_create" || part.type === "tool-panel_update") {
    const panel =
      part.state === "output-available" ? panelResult(part.output) : null

    return (
      <>
        {part.input === undefined ? null : <ToolInput input={part.input} />}
        {panel ? (
          <div className="border-t p-3">
            <Link
              href={panel.path}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <LayoutDashboardIcon className="size-3.5" aria-hidden />
              Abrir «{panel.name}»
            </Link>
          </div>
        ) : (
          <ToolOutput
            errorText={error}
            output={
              part.state === "output-available" ? part.output : undefined
            }
          />
        )}
      </>
    )
  }

  // Screenshots are for the bot's eyes and stay out of the chat
  if (
    part.type === "tool-viewScreen" ||
    part.type === "tool-showScreen" ||
    part.type === "tool-browser_screenshot" ||
    part.type === "tool-pc_screenshot"
  ) {
    return (
      <ToolOutput
        errorText={error}
        output={
          part.state === "output-available" ? (
            <p className="p-3 text-muted-foreground">
              {part.type === "tool-viewScreen"
                ? "Took a screenshot for its own use."
                : "Took a screenshot."}
            </p>
          ) : undefined
        }
      />
    )
  }

  if (part.type === "tool-bash") {
    return (
      <>
        {part.input?.command ? (
          <CodeBlock code={part.input.command} language="bash" />
        ) : null}
        <ToolOutput
          errorText={error}
          output={
            part.state === "output-available" ? (
              <CodeBlock
                code={part.output.output || `Exit code ${part.output.exitCode}`}
                language="log"
              />
            ) : undefined
          }
        />
      </>
    )
  }

  return (
    <>
      {part.input === undefined ? null : <ToolInput input={part.input} />}
      <ToolOutput
        errorText={error}
        output={part.state === "output-available" ? part.output : undefined}
      />
    </>
  )
}

// A reply is one message even when a handoff changes who is writing it, so it
// is cut at each handoff and every stretch gets its own author. Only a group
// chat passes bots, so only its replies get a face.
function splitByAuthor(message: ChatUIMessage, bots: ChatBot[]) {
  const findBot = (botId?: string) => bots.find((bot) => bot.id === botId)

  let section = {
    author:
      message.role === "assistant"
        ? findBot(message.metadata?.botId)
        : undefined,
    parts: [] as ChatUIMessage["parts"],
  }
  const sections = [section]

  for (const part of message.parts) {
    section.parts.push(part)

    if (part.type === "tool-handoff" && part.state === "output-available") {
      section = { author: findBot(part.output.botId), parts: [] }
      sections.push(section)
    }
  }

  return sections
}

/**
 * What to tell the person when a turn failed.
 *
 * The cause decides the advice: missing keys, rejected keys and "every model is
 * busy" need three different actions, and offering "try again" for the first
 * two wastes the person's time until an operator fixes the deployment.
 */
function failureToast(message: string) {
  const code = aiFailureCodeOf(message)

  if (code === "not_configured") {
    return {
      type: "error" as const,
      title: "Faltan las claves de IA",
      description:
        "No hay ningún proveedor configurado. Añade OPENROUTER_API_KEY (o Gemini, Cerebras, Groq o Cloudflare) a las variables del despliegue y del worker de Trigger.dev, que es donde se ejecuta el chat.",
    }
  }

  if (code === "auth_rejected") {
    return {
      type: "error" as const,
      title: "Claves de IA rechazadas",
      description:
        "Todos los proveedores configurados respondieron 401. Sustituye las claves en el despliegue y en el worker de Trigger.dev: reintentar no lo arregla.",
    }
  }

  if (code === "no_eligible_model") {
    return {
      type: "error" as const,
      title: "Ningún modelo puede con esta tarea",
      description:
        "El catálogo no tiene un modelo con las capacidades que pide esta llamada (por ejemplo, visión o esquema JSON estricto). Revisa Settings → Integrations → Runtime de modelos.",
    }
  }

  if (code === "unavailable") {
    return {
      type: "error" as const,
      title: "Ningún proveedor pudo responder",
      description:
        "Todos los modelos fallaron o están en espera por límite de cuota. Vuelve a intentarlo en un momento; el motivo concreto queda en Settings → Integrations → Runtime de modelos.",
    }
  }

  if (/TRIGGER_SECRET_KEY/.test(message)) {
    return {
      type: "error" as const,
      title: "El chat no está conectado",
      description:
        "El turno se ejecuta en Trigger.dev y falta TRIGGER_SECRET_KEY en el servidor. No se llegó a llamar a ningún modelo.",
    }
  }

  if (/free-model allowance|free-models-per-day/i.test(message)) {
    return {
      type: "error" as const,
      title: "Sin cuota de modelos gratuitos",
      description:
        "El límite diario de modelos gratuitos de OpenRouter está agotado. Se renueva a medianoche UTC; añadir 10 créditos a la cuenta lo sube a 1000 peticiones al día.",
    }
  }

  return {
    type: "error" as const,
    title: "El agente no pudo responder",
    description:
      "El modelo no llegó a responder. Vuelve a intentarlo; si se repite, revisa Settings → Integrations → Runtime de modelos.",
  }
}

// `bots` are a group chat's members to pick from; a direct chat passes none.
// `orchestrator` is the hidden agent that fronts direct conversations; when it
// is there and the chat is still empty, the chat opens with its welcome.
function Chat({
  chatId,
  bots,
  orchestrator,
  initialPrompt,
}: {
  chatId: string
  bots?: ChatBot[]
  orchestrator?: ChatBot
  initialPrompt?: string
}) {
  const transport = useTriggerChatTransport<typeof chatAgent>({
    task: "chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
  })
  const { messages, isLoading, error } = useLoadTranscript(
    chatId,
    loadTranscript,
    { transport }
  )

  // useChat only reads its initial messages on mount, so wait for the
  // transcript — and when it cannot be fetched, say so instead of showing an
  // empty conversation as if there had never been one.
  if (isLoading) {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
      >
        <Spinner />
        Cargando la conversación…
      </div>
    )
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <p className="text-sm font-medium">
          No se pudo cargar la conversación
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {error.message || "Ocurrió un error inesperado al leer el historial."}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Reintentar
        </Button>
      </div>
    )
  }

  return (
    <ChatMessages
      key={chatId}
      chatId={chatId}
      bots={bots}
      orchestrator={orchestrator}
      initialMessages={messages}
      transport={transport}
      initialPrompt={initialPrompt}
    />
  )
}

// Lives inside <Conversation>, the one place the StickToBottom context exists,
// and hands the parent a single callable: bring the view to the bottom. No
// polling, no repeating timers — it is the same engine that already decides,
// from real scroll position, whether to keep following or leave the reader
// alone.
function ScrollRegistrar({
  register,
}: {
  register: (fn: () => void) => void
}) {
  const { scrollToBottom } = useStickToBottomContext()
  useEffect(() => {
    register(() => {
      void scrollToBottom()
    })
  }, [register, scrollToBottom])
  return null
}

// Attaching has to be visible, not merely possible: this opens the file dialog
// the PromptInput owns. It renders inside the footer, where the input's
// attachment context lives, and never submits the form.
function AttachFilesButton() {
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton
      aria-label="Adjuntar archivos o imágenes"
      onClick={() => attachments.openFileDialog()}
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  )
}

// What is attached but not sent yet, as chips that can be taken back — so
// attaching a file is never invisible, and nothing is attached by accident.
function PendingFiles() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null

  return (
    <ul className="flex w-full flex-wrap gap-1 px-1 pt-1">
      {attachments.files.map((file) => (
        <li
          key={file.id}
          className="flex max-w-40 items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground"
        >
          <span className="truncate">{file.filename}</span>
          <button
            type="button"
            aria-label={`Quitar ${file.filename}`}
            onClick={() => attachments.remove(file.id)}
            className="rounded text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
}

function ChatMessages({
  chatId,
  bots = [],
  orchestrator,
  initialMessages,
  transport,
  initialPrompt,
}: {
  chatId: string
  bots?: ChatBot[]
  orchestrator?: ChatBot
  initialMessages: ChatUIMessage[]
  transport: TriggerChatTransport
  initialPrompt?: string
}) {
  const { checkPlan, showUsageLimit } = usePaywall()
  const { messages, sendMessage, status, stop } = useChat<ChatUIMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
    // The agent refuses a turn once the period's allowance is spent
    onError: (error) => {
      if (error.message === USAGE_LIMIT_ERROR) return showUsageLimit("ai")

      // Handled here, so nothing else tells us a reply never arrived
      Sentry.logger.error("Chat reply failed", {
        "chat.id": chatId,
        "error.type": error.name,
        "error.message": error.message,
      })

      // A failed turn must say so, and must say the true cause: "the model did
      // not answer" is misleading when no model was ever called because a
      // variable is missing or every key was rejected.
      toast.add(failureToast(error.message))
    },
  })
  // The bot the next message goes to, in a group chat
  const [botId, setBotId] = useState(bots[0]?.id)
  // The lattice loader shows for every turn: it appears when one is sent,
  // freezes into the done/error mark with the stopwatch stopped, then leaves.
  const [lattice, setLattice] = useState<"hidden" | "working" | "done" | "error">("hidden")
  const turnRunning = useRef(false)
  // A prompt handed over from the Agent section is sent exactly once
  const sentInitial = useRef(false)

  // The draft the person has not sent yet: read once when this view mounts
  // (a lazy initializer, not an effect — and this component only ever renders
  // in the browser, because the transcript gate above is always loading on the
  // server), written on every change, cleared only when the message goes out.
  const [draft, setDraft] = useState<string>(() => {
    try {
      return window.sessionStorage.getItem(DRAFT_KEY) ?? ""
    } catch {
      // Storage unavailable (e.g. private mode): the draft starts empty
      return ""
    }
  })

  const applyDraft = (value: string) => {
    setDraft(value)
    try {
      if (value) window.sessionStorage.setItem(DRAFT_KEY, value)
      else window.sessionStorage.removeItem(DRAFT_KEY)
    } catch {
      // Nothing more to do: this page's state still holds the draft
    }
  }

  // How the view comes back to the bottom on send. Registered by the
  // ScrollRegistrar inside <Conversation>, where the scroll context lives.
  const scrollBottom = useRef<(() => void) | null>(null)
  const registerScrollBottom = useCallback((fn: () => void) => {
    scrollBottom.current = fn
  }, [])

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      turnRunning.current = true
      setLattice("working")
      return
    }
    if (!turnRunning.current) return
    turnRunning.current = false
    if (status === "error") {
      setLattice("error")
      const id = setTimeout(() => setLattice("hidden"), 3600)
      return () => clearTimeout(id)
    }
    setLattice("done")
    const id = setTimeout(() => setLattice("hidden"), 2400)
    return () => clearTimeout(id)
  }, [status])

  // A turn that never starts streaming is not "still thinking": the run was
  // created but no worker picked it up, so no model was ever called and no
  // reply is coming. Sitting on the loader forever hides a real outage, so
  // after this long the turn is given up on and said out loud.
  useEffect(() => {
    if (status !== "submitted") return

    const id = setTimeout(() => {
      stop()
      Sentry.logger.error("Chat turn never started", {
        "chat.id": chatId,
        "timeout.ms": SUBMITTED_TIMEOUT_MS,
      })
      toast.add({
        type: "error",
        title: "El agente no arrancó",
        description:
          "Ningún worker procesó la solicitud, así que no llegó a llamarse al modelo. En desarrollo arranca el entorno completo con `npm run dev` (ya incluye el worker) y reenvía el mensaje; en producción, revisa que el worker de Trigger.dev esté desplegado.",
      })
    }, SUBMITTED_TIMEOUT_MS)

    return () => clearTimeout(id)
  }, [status, stop, chatId])

  // Falls back to the first one when the picked bot is removed from the group
  const selectedBot = bots.find((bot) => bot.id === botId) ?? bots[0]

  // The Agent section's composer opens the chat with the draft in the URL, so
  // the first turn starts without the person having to type it again.
  useEffect(() => {
    if (!initialPrompt || sentInitial.current || status !== "ready") return
    sentInitial.current = true
    const metadata = selectedBot && { botId: selectedBot.id }
    sendMessage({ text: initialPrompt, metadata }, { metadata })
    window.history.replaceState(null, "", `/chats/${chatId}`)
  }, [initialPrompt, status, selectedBot, sendMessage, chatId])

  // Automatically update selectedBot when the backend routes to a different agent
  // The backend sets botId in message metadata via pickAgent routing
  useEffect(() => {
    // Find the most recent user message with a botId in metadata (from routing)
    const lastUserMessage = messages.find((msg) => msg.role === "user" && msg.metadata?.botId)
    if (lastUserMessage && lastUserMessage.metadata?.botId) {
      const routedBotId = lastUserMessage.metadata.botId
      const existingBot = bots.find((bot) => bot.id === routedBotId)
      if (existingBot && existingBot.id !== botId) {
        setBotId(existingBot.id)
      }
    }
  }, [messages, bots])


  function handleSubmit(message: PromptInputMessage) {
    const text = message.text
    if (!text.trim()) return

    try {
      // Throwing keeps the draft in the input
      if (!checkPlan("bots")) throw new Error("Upgrade required")
      // The agent reads this turn's metadata to decide which bot answers
      // and the message keeps it too, to show who it was for
      const metadata = selectedBot && { botId: selectedBot.id }
      // The attachments PromptInput converted ride along with the text: the
      // same send the Enter key and the send button use.
      sendMessage(
        {
          text,
          ...(message.files.length ? { files: message.files } : {}),
          metadata,
        },
        { metadata }
      )

      // The message is away: its draft is spent, and the view comes to the
      // new exchange even if the person had scrolled up to read earlier ones.
      applyDraft("")
      scrollBottom.current?.()
    } catch (error) {
      // PromptInput resets the form before calling us, so the draft this
      // throw exists to protect has to be restored through state — that is
      // what redraws it in the textarea.
      applyDraft(text)
      throw error
    }
  }

  // A suggestion is a real send through the same transport — not a prefilled
  // draft, not a simulation. It leaves whatever the person is typing alone,
  // and it is inert while a turn is running, like the send button.
  function sendSuggestion(text: string) {
    if (status !== "ready") return
    if (!checkPlan("bots")) return
    const metadata = selectedBot && { botId: selectedBot.id }
    sendMessage({ text, metadata }, { metadata })
    scrollBottom.current?.()
  }

  // A direct chat the orchestrator fronts opens on the compact empty state:
  // no welcome screen, just enough to start typing or tap a suggestion. Once a
  // message exists it disappears for good, and a recovered conversation never
  // shows it over its own messages.
  const showEmptyState = Boolean(orchestrator) && messages.length === 0

  return (
    <div data-slot="chat" className="flex min-h-0 flex-1 flex-col">
      <Conversation initial="instant" resize="instant">
        <ScrollRegistrar register={registerScrollBottom} />
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {showEmptyState && (
            <div className="flex-1 flex-col items-center justify-center gap-5 px-2 text-center">
              <div className="flex flex-col items-center gap-1.5">
                <ChatAvatar seed={orchestrator!.avatar} className="size-10" />
                <p className="text-xs text-muted-foreground">Godfather</p>
                <p className="text-lg font-semibold tracking-tight">
                  {EMPTY_STATE_QUESTION}
                </p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {EMPTY_STATE_SUBTITLE}
                </p>
              </div>
              <ul className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      onClick={() => sendSuggestion(suggestion)}
                      disabled={status !== "ready"}
                      className="rounded-full border border-border/60 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {messages.flatMap((message) => {
            // The bot a group chat's message was sent to
            const addressee =
              message.role === "user"
                ? bots.find((bot) => bot.id === message.metadata?.botId)
                : undefined

            // A direct chat passes no `bots`, but its replies still come from
            // the orchestrator that fronts it: with it as the lookup, Godfather's
            // own sections get its avatar, and a section a specialist wrote
            // after a handoff matches no one and stays unadorned — the handoff
            // line above it already says who wrote it.
            const authors =
              bots.length > 0 ? bots : orchestrator ? [orchestrator] : []

            return splitByAuthor(message, authors).map(({ author, parts }, i) => {
              const renderedParts = parts.map((part, j) => {
                if (part.type === "text") {
                  return (
                    <MessageResponse
                      key={`${message.id}-${i}-${j}`}
                      // Flows the first paragraph inline, right after the tag
                      className={
                        addressee && j === 0
                          ? "inline [&>p:first-child]:inline"
                          : undefined
                      }
                    >
                      {part.text}
                    </MessageResponse>
                  )
                }
                // The person's own attachment, shown as what it is: a compact
                // chip inside the conversation. Tool-side files stay in the
                // tool panel where they were.
                if (part.type === "file") {
                  return (
                    <span
                      key={`${message.id}-${i}-${j}`}
                      className="flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border/40 bg-background/20 px-2 py-0.5 text-xs"
                    >
                      <PaperclipIcon className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {part.filename ?? "Archivo adjunto"}
                      </span>
                    </span>
                  )
                }
                // The environment question is a control, not a tool log line:
                // its buttons answer the task the tool created.
                if (
                  part.type === "tool-request_execution_environment" &&
                  part.state === "output-available"
                ) {
                  const metadata = selectedBot && { botId: selectedBot.id }
                  return (
                    <ExecutionEnvironmentCard
                      key={part.toolCallId}
                      output={part.output}
                      onResume={(text) =>
                        sendMessage({ text, metadata }, { metadata })
                      }
                    />
                  )
                }
                if (part.type !== "dynamic-tool" && isToolUIPart(part)) {
                  return <ToolCall key={part.toolCallId} part={part} />
                }
                return null
              })

              return (
                <Message
                  from={message.role}
                  key={`${message.id}-${i}`}
                  className={author && "flex-row items-start"}
                >
                  {author && (
                    <ChatAvatar seed={author.avatar} className="size-6" />
                  )}
                  <MessageContent>
                    {addressee ? (
                      // One block, so the tag and the text share a line and the text wraps under it
                      <div>
                        <Badge
                          variant="outline"
                          className="mr-1.5 max-w-40 pl-1 align-top"
                        >
                          <ChatAvatar
                            seed={addressee.avatar}
                            className="size-3.5"
                          />
                          <span className="truncate">{addressee.name}</span>
                        </Badge>
                        {renderedParts}
                      </div>
                    ) : (
                      renderedParts
                    )}
                  </MessageContent>
                </Message>
              )
            })
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4 pt-0">
        {lattice !== "hidden" && (
          <div className="pb-3">
            {/* Violet ink matches the identity palette; green/red marks are
                the semantic finish states. */}
            <LatticeLoader status={lattice} color="#a78bfa" glow />
          </div>
        )}
        <PromptInput
          className="rounded-xl bg-card p-1 shadow-sm ring-1 ring-border/50"
          onSubmit={handleSubmit}
        >
          <PromptInputTextarea
            placeholder="Send a message..."
            value={draft}
            onChange={(event) => applyDraft(event.currentTarget.value)}
          />
          <PendingFiles />
          <PromptInputFooter>
            <PromptInputTools>
              <AttachFilesButton />
              {selectedBot && (
                <PromptInputSelect
                  value={selectedBot.id}
                  onValueChange={(value) => setBotId(value as string)}
                >
                  <PromptInputSelectTrigger aria-label="Bot to talk to">
                    <PromptInputSelectValue>
                      <ChatAvatar
                        seed={selectedBot.avatar}
                        className="size-5"
                      />
                      {selectedBot.name}
                    </PromptInputSelectValue>
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {bots.map((bot) => (
                      <PromptInputSelectItem key={bot.id} value={bot.id}>
                        <ChatAvatar seed={bot.avatar} className="size-5" />
                        {bot.name}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              )}
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={stop} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

export { Chat }
