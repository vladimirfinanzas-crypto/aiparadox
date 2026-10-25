// Development supervisor — one terminal, one command.
//
//   npm run dev              Next.js + local Trigger.dev worker, supervised
//   npm run dev:web          Next.js only (the old `npm run dev`)
//   npm run dev:worker       worker only, for diagnostics (no auto-restart)
//
// Why this exists: Godfather needs BOTH the Next server and a local Trigger.dev
// worker to answer a chat, and running them in two terminals means the worker
// silently dies when its terminal closes and the chat spins forever. This
// script starts both, prefixes their logs, watches the worker's real state,
// restarts it only when the process actually dies (with a capped backoff so a
// persistent misconfiguration cannot loop forever) and tears everything down
// on Ctrl+C so no orphan processes survive.
//
// No new dependencies: plain Node, works on Windows (the target dev OS).

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const ROOT = process.cwd()
const workerOnly = process.argv.includes("--worker-only")
const isWin = process.platform === "win32"

const WEB_COLOR = "\x1b[36m" // cyan
const WORKER_COLOR = "\x1b[35m" // magenta
const DEV_COLOR = "\x1b[33m" // yellow
const RESET = "\x1b[0m"
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (useColor ? code : "")

function stamp() {
  return new Date().toTimeString().slice(0, 8)
}

function devMsg(text) {
  console.log(`${paint(DEV_COLOR)}[dev    ]${paint(RESET)} ${stamp()} ${text}`)
}

function stateMsg(text) {
  // Machine-readable state lines: `worker-state: <estado>` plus a human note.
  console.log(`${paint(DEV_COLOR)}[worker ]${paint(RESET)} ${stamp()} worker-state: ${text}`)
}

function prefixStream(stream, name, colorCode, onLine) {
  let buffer = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      if (onLine) onLine(line)
      console.log(`${paint(colorCode)}[${name}]${paint(RESET)} ${stamp()} ${line}`)
    }
  })
}

// ---------------------------------------------------------------------------
// Environment check (names only — a missing variable is reported by name and
// its value is never printed, here or anywhere in this supervisor).
// ---------------------------------------------------------------------------
function envFileKeys(files) {
  const keys = new Set()
  for (const file of files) {
    const full = path.join(ROOT, file)
    if (!existsSync(full)) continue
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/)
      if (match) keys.add(match[1])
    }
  }
  return keys
}

const localKeys = envFileKeys([".env", ".env.local"])
const hasVar = (name) => !!process.env[name] || localKeys.has(name)

// ---------------------------------------------------------------------------
// Worker lock: at most ONE local worker, whether it was started by this
// supervisor or by `npm run dev:worker` for diagnostics.
// ---------------------------------------------------------------------------
const LOCK_PATH = path.join(ROOT, ".dev-worker.lock")

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock() {
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"))
    return typeof lock?.pid === "number" ? lock : null
  } catch {
    return null
  }
}

function acquireLock(kind) {
  const existing = readLock()
  if (existing && pidAlive(existing.pid)) return { ok: false, lock: existing }
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, kind, startedAt: new Date().toISOString() }))
  return { ok: true }
}

function releaseLock() {
  const lock = readLock()
  if (lock?.pid === process.pid) {
    try {
      rmSync(LOCK_PATH, { force: true })
    } catch {
      // A stale lock file is harmless: the pid check above already ignores it
    }
  }
}

// ---------------------------------------------------------------------------
// Process control. On Windows a `.cmd` child (npx) owns grandchildren, so the
// whole tree is taken down with taskkill; on POSIX the child runs as its own
// process group and gets a group signal.
// ---------------------------------------------------------------------------
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (isWin) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      process.kill(-child.pid, "SIGTERM")
    }
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // Already gone
    }
  }
}

// ---------------------------------------------------------------------------
// Worker state machine (FASE 3). "Process exists" is NOT "connected": the
// states come from the CLI's own markers, which is the most reliable signal
// this architecture offers — Trigger.dev 4.7.x exposes no health endpoint for
// the dev worker.
//
//   starting    spawned, waiting for the ready marker
//   ready       `Local worker ready` seen — tasks can be delivered
//   degraded    alive but reporting errors (env/network trouble)
//   disconnected  `Connection was lost` / `ping timeout` seen
//   stopped     process gone and no restart left (or shutdown)
//
const READY_MARKER = /Local worker ready/i
const LOST_MARKER = /Connection was lost|ping timeout/i
const ERROR_MARKER = /\b(error|failed|unauthorized|invalid)\b/i

// Reconnection policy: Trigger's own recovery gets time to work first. Only a
// worker that stays disconnected after DISCONNECT_GRACE_MS, or that exits, is
// restarted — and every restart spends from the same capped budget, so a
// persistent fault (bad key, offline network) ends in `stopped` with an
// explanation instead of an infinite loop.
const DISCONNECT_GRACE_MS = Number(process.env.DEV_WORKER_DISCONNECT_GRACE_MS ?? 180_000)
const BACKOFF_MS = (process.env.DEV_WORKER_BACKOFF_MS ?? "1000,2000,5000,10000,30000")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0)
const MAX_RESTARTS = BACKOFF_MS.length
const STABLE_AFTER_MS = 60_000 // a ready minute resets the restart budget

let worker = null
let workerState = workerOnly ? "starting" : "stopped"
let restarts = 0
let readyAt = 0
let disconnectedAt = 0
let restartTimer = null
let graceTimer = null
let shuttingDown = false

function setWorkerState(next, note) {
  if (workerState === next && !note) return
  workerState = next
  stateMsg(`${next}${note ? ` — ${note}` : ""}`)
}

function clearWorkerTimers() {
  if (restartTimer) clearTimeout(restartTimer)
  if (graceTimer) clearTimeout(graceTimer)
  restartTimer = null
  graceTimer = null
}

function handleWorkerLine(line) {
  if (READY_MARKER.test(line)) {
    disconnectedAt = 0
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = null
    const wasReady = workerState === "ready"
    readyAt = Date.now()
    setWorkerState("ready")
    // A worker that stays ready for a while has proven the fault is gone and
    // earns its restart budget back — but only if it was not already ready
    // (the marker can repeat on reconnects).
    if (!wasReady && restarts > 0) {
      setTimeout(() => {
        if (!shuttingDown && workerState === "ready") restarts = 0
      }, STABLE_AFTER_MS)
    }
    return
  }
  if (LOST_MARKER.test(line)) {
    if (!disconnectedAt) {
      disconnectedAt = Date.now()
      setWorkerState(
        "disconnected",
        `se perdió la conexión; la reconexión nativa tiene ${Math.round(DISCONNECT_GRACE_MS / 1000)} s antes de un reinicio controlado`
      )
      graceTimer = setTimeout(() => {
        if (shuttingDown || !disconnectedAt) return
        restartWorker("la conexión no se recuperó dentro del plazo")
      }, DISCONNECT_GRACE_MS)
    }
    return
  }
  if (ERROR_MARKER.test(line) && workerState === "ready") {
    setWorkerState("degraded", "el worker sigue vivo pero reporta un error (revisa el mensaje anterior)")
  }
}

function restartBudgetLeft() {
  // A long-lived ready worker earns its budget back
  if (restarts >= MAX_RESTARTS) {
    if (readyAt && Date.now() - readyAt > STABLE_AFTER_MS) restarts = 0
    else return false
  }
  return true
}

function startWorker(kind = "supervisor") {
  const lock = acquireLock(kind)
  if (!lock.ok) {
    setWorkerState(
      "stopped",
      `ya hay un worker local (pid ${lock.lock.pid}, ${lock.lock.kind}); no se inicia otro. Ciérralo antes de lanzar este comando.`
    )
    if (workerOnly) process.exit(1)
    return
  }

  if (!hasVar("TRIGGER_SECRET_KEY")) {
    setWorkerState(
      "stopped",
      "Falta la variable TRIGGER_SECRET_KEY (define su nombre en .env o .env.local; este script nunca imprime valores). Godfather no podrá ejecutar tareas sin ella."
    )
    releaseLock()
    if (workerOnly) process.exit(1)
    return
  }

  spawnWorker()
}

function spawnWorker() {
  clearWorkerTimers()
  disconnectedAt = 0
  readyAt = 0
  setWorkerState("starting")

  // The same command `npm run dev:worker` has always run; the CLI loads .env /
  // .env.local itself, so no credential ever passes through this script.
  const command = isWin ? "npx.cmd" : "npx"
  const args = ["--yes", "trigger.dev@4.7.4", "dev"]
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    shell: isWin, // `.cmd` shims need a shell on Windows
    detached: !isWin, // own process group on POSIX so we can signal the tree
    stdio: ["ignore", "pipe", "pipe"],
  })
  worker = child
  devMsg(`worker iniciado (pid ${child.pid})`)

  prefixStream(child.stdout, "worker", WORKER_COLOR, handleWorkerLine)
  prefixStream(child.stderr, "worker", WORKER_COLOR, handleWorkerLine)


  child.on("error", (error) => {
    setWorkerState("stopped", `no se pudo lanzar el worker: ${error.message}`)
    scheduleRestart()
  })

  child.on("exit", (code, signal) => {
    worker = null
    clearWorkerTimers()
    disconnectedAt = 0
    readyAt = 0 // the next worker must earn stability itself
    if (shuttingDown) return

    if (code === 0) {
      // A clean exit is not a crash: the CLI decided to stop (e.g. logged out).
      setWorkerState("stopped", "el worker terminó con código 0; no se reinicia automáticamente")
      releaseLock()
      return
    }

    setWorkerState("stopped", `el worker terminó inesperadamente (code=${code} signal=${signal ?? "-"})`)
    scheduleRestart()
  })
}

function scheduleRestart() {
  if (shuttingDown) return
  if (!restartBudgetLeft()) {
    setWorkerState(
      "stopped",
      `sin reinicios disponibles (${MAX_RESTARTS} agotados). Comprueba TRIGGER_SECRET_KEY, la red/VPN y ejecuta \`npm run dev:worker\` a mano para ver el error real. El servidor web sigue activo.`
    )
    releaseLock()
    return
  }
  const delay = BACKOFF_MS[Math.min(restarts, BACKOFF_MS.length - 1)]
  restarts += 1
  devMsg(`worker: reinicio ${restarts}/${MAX_RESTARTS} en ${delay} ms`)
  restartTimer = setTimeout(() => {
    if (shuttingDown) return
    if (readLock()?.pid !== process.pid) {
      const lock = acquireLock("supervisor")
      if (!lock.ok) {
        setWorkerState("stopped", `otro worker (pid ${lock.lock.pid}) tiene el candado; no se reinicia`)
        return
      }
    }
    spawnWorker()
  }, delay)
}

// ---------------------------------------------------------------------------
// Web server (the old `npm run dev`). If it dies, the environment is unusable:
// say so, stop the worker and exit non-zero instead of leaving a zombie shell.
// ---------------------------------------------------------------------------
let web = null

function startWeb() {
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next")
  const child = spawn(process.execPath, [nextBin, "dev", "-p", "3000"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWin,
  })
  web = child
  devMsg(`servidor web iniciado (pid ${child.pid}) en http://localhost:3000`)
  prefixStream(child.stdout, "web   ", WEB_COLOR)
  prefixStream(child.stderr, "web   ", WEB_COLOR)

  child.on("error", (error) => {
    devMsg(`el servidor web no pudo arrancar: ${error.message}`)
    shutdown(1)
  })
  child.on("exit", (code, signal) => {
    web = null
    if (shuttingDown) return
    devMsg(`el servidor web terminó inesperadamente (code=${code} signal=${signal ?? "-"})`)
    shutdown(1)
  })
}

// ---------------------------------------------------------------------------
// Shutdown: manual stop must never trigger an automatic restart.
// ---------------------------------------------------------------------------
let exiting = false

function shutdown(exitCode = 0) {
  if (exiting) return
  exiting = true
  shuttingDown = true
  clearWorkerTimers()
  devMsg("parando el entorno…")

  const children = [web, worker].filter(Boolean)
  for (const child of children) killTree(child)

  releaseLock()

  const deadline = Date.now() + 8_000
  const timer = setInterval(() => {
    const alive = [web, worker].filter((c) => c && c.exitCode === null && c.signalCode === null)
    if (alive.length === 0 || Date.now() > deadline) {
      clearInterval(timer)
      devMsg("entorno detenido")
      process.exit(exitCode)
    }
  }, 250)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(0))
}
process.on("exit", () => {
  shuttingDown = true
  for (const child of [web, worker]) if (child) killTree(child)
  releaseLock()
})

// ---------------------------------------------------------------------------
devMsg(`Paradox en modo desarrollo (${workerOnly ? "solo worker — diagnóstico" : "web + worker"})`)
if (!hasVar("DATABASE_URL")) devMsg("AVISO: falta la variable DATABASE_URL (nombre; valor nunca mostrado) — la web no podrá consultar la base de datos.")
if (workerOnly) {
  startWorker("dev:worker")
} else {
  startWeb()
  startWorker("supervisor")
}
