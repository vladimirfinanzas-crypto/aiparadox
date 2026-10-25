// ---------------------------------------------------------------------------
// Execution Router — where should this task run?
//
// Godfather decides *what* the person wants; this decides *where* it happens:
//
//   - an authorized integration API, when one answers the same question,
//   - the person's own computer (Desktop Agent: local browser + desktop),
//   - a managed cloud browser (Browserbase),
//   - or a question with buttons, when the person has not said and both are
//     reasonable.
//
// The policy is a pure function on purpose: it is the part of the routing that
// must be provable without a model, a browser or a database. The chat task and
// the environment-request tool both call it, so the rule that "nothing runs
// before an environment is chosen" is enforced in one place.
// ---------------------------------------------------------------------------

import type { ExecutionEnvironment } from "@/db/schema"

/** The environment the person may pick, or cancelling the request. */
export type EnvironmentChoice = ExecutionEnvironment | "cancel"

export type EnvironmentOption = {
  id: EnvironmentChoice
  label: string
  description?: string
  /** True when this route cannot run right now; the card shows why. */
  disabled?: boolean
}

export type EnvironmentAvailability = {
  cloud: { available: boolean; reason?: string }
  local: { available: boolean; reason?: string }
}

export const ENVIRONMENT_QUESTION = "¿Dónde quieres ejecutar esta tarea?"

export const ENVIRONMENT_OPTIONS: Record<ExecutionEnvironment, EnvironmentOption> = {
  cloud: {
    id: "cloud",
    label: "Navegador cloud — Browserbase",
    description:
      "Un navegador remoto independiente de tu PC. No usa tus sesiones ni tus cookies.",
  },
  local: {
    id: "local",
    label: "Navegador de mi PC",
    description:
      "El navegador y las capacidades locales de tu computadora, a través de Paradox Desktop Agent.",
  },
}

export const CANCEL_OPTION: EnvironmentOption = {
  id: "cancel",
  label: "Cancelar",
  description: "Detiene la solicitud sin ejecutar la tarea.",
}

/** The buttons for one decision, disabled where a route cannot run. */
export function environmentOptions(
  availability: EnvironmentAvailability
): EnvironmentOption[] {
  return [
    {
      ...ENVIRONMENT_OPTIONS.cloud,
      disabled: !availability.cloud.available,
    },
    {
      ...ENVIRONMENT_OPTIONS.local,
      disabled: !availability.local.available,
    },
    CANCEL_OPTION,
  ]
}

// Words that name an environment outright. Kept narrow: a false positive means
// the person is never asked, which is the failure mode this feature exists to
// prevent.
const CLOUD_PATTERNS = [
  /\bbrowserbase\b/i,
  /\bnavegador (?:en |de )?(?:la )?nube\b/i,
  /\bnavegador cloud\b/i,
  /\bcloud browser\b/i,
  /\ben la nube\b/i,
  /\bremote browser\b/i,
]

const LOCAL_PATTERNS = [
  /\bmi (?:pc|computadora|computador|ordenador)\b/i,
  /\bmi navegador\b/i,
  /\bnavegador local\b/i,
  /\ben mi m[aá]quina\b/i,
  /\bmy (?:pc|computer|laptop|machine)\b/i,
  /\blocal browser\b/i,
  /\bdesktop agent\b/i,
]

/**
 * The environment the person asked for in their own words, if any. Local wins
 * over cloud when both appear, because "no, en mi PC, no en la nube" names the
 * machine it should use.
 */
export function detectExplicitEnvironment(
  text: string
): ExecutionEnvironment | undefined {
  const normalized = text ?? ""
  if (LOCAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "local"
  }
  if (CLOUD_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "cloud"
  }
  return undefined
}

// Words that ask for web work. This is a fallback for the tool guard and for
// logging, never a replacement for the model's own judgement.
const WEB_PATTERNS = [
  /\bscrap(?:e|ing|er)\b/i,
  /\bnavega(?:r|dor)?\b/i,
  /\binvestiga(?:r)?\b/i,
  /\bextrae(?:r)?\b/i,
  /\bprecios?\b/i,
  /\bp[aá]ginas?\b/i,
  /\bsitios? web\b/i,
  /\burl\b/i,
  /\bhttps?:\/\//i,
  /\bcompara(?:r)?\b/i,
  /\bbrowse\b/i,
  /\bcrawl(?:er|ing)?\b/i,
  /\bwebsites?\b/i,
  /\bresearch\b/i,
]

/** True when the request plainly needs a browser rather than a plain answer. */
export function looksLikeWebTask(text: string): boolean {
  const normalized = text ?? ""
  return WEB_PATTERNS.some((pattern) => pattern.test(normalized))
}

export type RouteInput = {
  /** What the person asked, in their words. */
  request: string
  /**
   * Whether the work needs a browser. The model sets this; when it is omitted
   * the text heuristic above is used.
   */
  needsBrowser?: boolean
  /** Set when the person named an environment; defaults to detectExplicit. */
  explicitEnvironment?: ExecutionEnvironment
  /** True when an authorized API returns the same data, so no browser is needed. */
  apiResolvable?: boolean
  availability: EnvironmentAvailability
}

export type RouteDecision =
  /** Answer from an integration API; no browser is opened. */
  | { kind: "api"; reason: string }
  /** Ask the person with buttons; nothing runs until they answer. */
  | { kind: "ask"; reason: string; question: string; options: EnvironmentOption[] }
  /** Run in a named environment. */
  | { kind: "run"; environment: ExecutionEnvironment; reason: string }
  /**
   * The person chose an environment that cannot run right now. Reported, never
   * silently replaced by the other one.
   */
  | { kind: "blocked"; environment: ExecutionEnvironment | null; reason: string }
  /** Nothing to browse: the request is answered directly. */
  | { kind: "direct"; reason: string }

export function decideExecutionRoute(input: RouteInput): RouteDecision {
  const explicit =
    input.explicitEnvironment ?? detectExplicitEnvironment(input.request)

  // A named environment is binding: run there, or say why it cannot run.
  if (explicit) {
    const route = input.availability[explicit]
    if (route.available) {
      return {
        kind: "run",
        environment: explicit,
        reason: `The person asked for ${explicit}.`,
      }
    }
    return {
      kind: "blocked",
      environment: explicit,
      reason:
        route.reason ??
        (explicit === "cloud"
          ? "The cloud browser is not configured."
          : "No computer with the Desktop Agent is online."),
    }
  }

  // An authorized API answers this better than a browser ever could.
  if (input.apiResolvable) {
    return {
      kind: "api",
      reason: "An authorized integration returns this data, so no browser is used.",
    }
  }

  const needsBrowser = input.needsBrowser ?? looksLikeWebTask(input.request)
  if (!needsBrowser) {
    return { kind: "direct", reason: "Nothing in the request needs a browser." }
  }

  return {
    kind: "ask",
    reason: "The request needs a browser and no environment was specified.",
    question: ENVIRONMENT_QUESTION,
    options: environmentOptions(input.availability),
  }
}

// ---------------------------------------------------------------------------
// Resolution checks — the rules a click has to pass
// ---------------------------------------------------------------------------

export type ResolvableTask = {
  userId: string
  status: string
  environment: ExecutionEnvironment | null
}

export type ResolutionCheck =
  | { ok: true; choice: EnvironmentChoice; duplicate: false }
  /** Already answered: repeated clicks are harmless and never duplicate work. */
  | {
      ok: true
      choice: EnvironmentChoice
      duplicate: true
      environment: ExecutionEnvironment | null
    }
  | {
      ok: false
      code: "not_owner" | "not_pending" | "unavailable"
      message: string
    }

/**
 * Validates one answer to the environment question. Ownership is checked before
 * status, so a stranger's click learns nothing about the task's state.
 */
export function checkResolution({
  task,
  requesterId,
  choice,
  availability,
}: {
  task: ResolvableTask | null
  requesterId: string
  choice: EnvironmentChoice
  availability: EnvironmentAvailability
}): ResolutionCheck {
  if (!task || task.userId !== requesterId) {
    return { ok: false, code: "not_owner", message: "Task not found" }
  }

  if (task.status !== "awaiting_execution_environment") {
    // A second click on a resolved card answers with what was already decided
    // instead of starting the work again.
    if (task.environment) {
      return {
        ok: true,
        choice: task.environment,
        duplicate: true,
        environment: task.environment,
      }
    }
    return {
      ok: false,
      code: "not_pending",
      message:
        task.status === "cancelled"
          ? "That task was cancelled."
          : "That task is no longer waiting for an environment.",
    }
  }

  if (choice === "cancel") {
    return { ok: true, choice, duplicate: false }
  }

  if (!availability[choice].available) {
    return {
      ok: false,
      code: "unavailable",
      message:
        availability[choice].reason ??
        (choice === "cloud"
          ? "The cloud browser is not configured."
          : "No computer with the Desktop Agent is online."),
    }
  }

  return { ok: true, choice, duplicate: false }
}

/**
 * The error a browser tool raises when there is no environment for the turn.
 * It tells the model exactly what to do next, so a missing question never turns
 * into an invented navigation.
 */
export const NO_ENVIRONMENT_ERROR =
  "No execution environment is selected for this task. Call request_execution_environment first and wait for the person to choose the cloud browser or their own PC; do not open any page before that."
