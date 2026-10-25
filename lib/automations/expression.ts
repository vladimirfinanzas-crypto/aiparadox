// Condition evaluation, without `eval`.
//
// A condition block holds a small expression the person can read:
//
//   {{ read.extraction }} contains "error"
//   {{ fetch.count }} >= 3
//   isEmpty({{ mail.id }})
//   {{ act.success }}
//
// It is parsed here, never handed to the JavaScript evaluator: a flow is data,
// and a definition that arrives from the model must not be able to run code.

export type ConditionResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string }

type Outputs = Record<string, unknown>

const PLACEHOLDER = /^\{\{\s*([^}]+?)\s*\}\}$/

const BINARY = /^(.*?)\s(===|!==|==|!=|>=|<=|>|<|contains|startsWith|endsWith|matches)\s(.*)$/i
const UNARY = /^(isEmpty|isNotEmpty|exists|missing)\(\s*(.*?)\s*\)$/i

/** Walks `nodeId.path[0].key` off the outputs map. Returns undefined as soon as
 *  the path leaves an object, instead of throwing. */
export function resolveOutputPath(outputs: Outputs, path: string): unknown {
  const keys = path
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .map((key) => key.trim())
    .filter(Boolean)

  return keys.reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined
    return (acc as Record<string, unknown>)[key]
  }, outputs)
}

function unquote(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length < 2) return undefined
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1).replace(/\\(["'\\])/g, "$1")
  }
  return undefined
}

type Operand = { kind: "value"; value: unknown } | { kind: "error"; error: string }

function parseOperand(raw: string, outputs: Outputs): Operand {
  const text = raw.trim()
  if (!text) return { kind: "error", error: "Falta un valor en la condición." }

  const placeholder = text.match(PLACEHOLDER)
  if (placeholder) {
    return { kind: "value", value: resolveOutputPath(outputs, placeholder[1] ?? "") }
  }

  const quoted = unquote(text)
  if (quoted !== undefined) return { kind: "value", value: quoted }

  if (/^-?\d+(\.\d+)?$/.test(text)) return { kind: "value", value: Number(text) }
  if (text === "true") return { kind: "value", value: true }
  if (text === "false") return { kind: "value", value: false }
  if (text === "null") return { kind: "value", value: null }

  // A bare word is a literal string, so `contains error` reads naturally.
  return { kind: "value", value: text }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.trim() !== "") return Number(value)
  return Number.NaN
}

function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value))
  }
  return false
}

/** What a value means in a boolean slot. The strings "false" and "0" are false,
 *  because a model that writes `{{ step.success }}` is quoting a boolean. */
export function truthy(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0 && Number.isFinite(value)
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    return text !== "" && text !== "false" && text !== "0" && text !== "null"
  }
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return true
}

export function evaluateCondition(expression: string, outputs: Outputs = {}): ConditionResult {
  const text = (expression ?? "").trim()
  if (!text) return { ok: false, error: "La condición está vacía." }

  const unary = text.match(UNARY)
  if (unary) {
    const operator = unary[1]!.toLowerCase()
    const operand = parseOperand(unary[2] ?? "", outputs)
    if (operand.kind === "error") return { ok: false, error: operand.error }

    switch (operator) {
      case "isempty":
        return { ok: true, value: !truthy(operand.value) }
      case "isnotempty":
        return { ok: true, value: truthy(operand.value) }
      case "exists":
        return { ok: true, value: operand.value !== undefined && operand.value !== null }
      case "missing":
        return { ok: true, value: operand.value === undefined || operand.value === null }
      default:
        return { ok: false, error: `Operador desconocido: ${operator}` }
    }
  }

  const binary = text.match(BINARY)
  if (!binary) {
    // A single operand is a truthiness test, which is what `{{ act.success }}`
    // looks like.
    const operand = parseOperand(text, outputs)
    if (operand.kind === "error") return { ok: false, error: operand.error }
    return { ok: true, value: truthy(operand.value) }
  }

  const [, rawLeft, rawOperator, rawRight] = binary
  const operator = rawOperator!.toLowerCase()
  const left = parseOperand(rawLeft ?? "", outputs)
  if (left.kind === "error") return { ok: false, error: left.error }
  const right = parseOperand(rawRight ?? "", outputs)
  if (right.kind === "error") return { ok: false, error: right.error }

  const a = left.value
  const b = right.value

  switch (operator) {
    case "==":
    case "===":
      if (isNumeric(a) && isNumeric(b)) return { ok: true, value: toNumber(a) === toNumber(b) }
      return { ok: true, value: String(a ?? "") === String(b ?? "") }
    case "!=":
    case "!==":
      if (isNumeric(a) && isNumeric(b)) return { ok: true, value: toNumber(a) !== toNumber(b) }
      return { ok: true, value: String(a ?? "") !== String(b ?? "") }
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const na = toNumber(a)
      const nb = toNumber(b)
      if (Number.isNaN(na) || Number.isNaN(nb)) {
        return {
          ok: false,
          error: `No puedo comparar "${String(a)}" con "${String(b)}" usando ${operator}.`,
        }
      }
      if (operator === ">") return { ok: true, value: na > nb }
      if (operator === ">=") return { ok: true, value: na >= nb }
      if (operator === "<") return { ok: true, value: na < nb }
      return { ok: true, value: na <= nb }
    }
    case "contains":
      if (Array.isArray(a)) {
        return {
          ok: true,
          value: a.some((item) =>
            typeof item === "object" ? JSON.stringify(item).includes(String(b)) : String(item) === String(b)
          ),
        }
      }
      return { ok: true, value: String(a ?? "").includes(String(b ?? "")) }
    case "startswith":
      return { ok: true, value: String(a ?? "").startsWith(String(b ?? "")) }
    case "endswith":
      return { ok: true, value: String(a ?? "").endsWith(String(b ?? "")) }
    case "matches": {
      try {
        return { ok: true, value: new RegExp(String(b ?? "")).test(String(a ?? "")) }
      } catch {
        return { ok: false, error: `La expresión regular "${String(b)}" no es válida.` }
      }
    }
    default:
      return { ok: false, error: `Operador desconocido: ${operator}` }
  }
}

/** The placeholders an expression reads, so the editor can offer them as chips
 *  and the validator can warn about references that will not exist. */
export function placeholdersIn(expression: string): string[] {
  const found = new Set<string>()
  for (const match of expression.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const path = match[1]?.trim()
    if (path) found.add(path)
  }
  return [...found]
}
