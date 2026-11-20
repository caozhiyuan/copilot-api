import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { PATHS } from "./storage/paths"
import { registerProcessCleanup } from "./process-cleanup"
import { requestContext } from "./http/request-context"
import { state } from "./state"

const LOG_RETENTION_DAYS = 7
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const DEFAULT_LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100

const getLogDir = () => process.env[LOG_DIR_ENV]?.trim() || DEFAULT_LOG_DIR

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()

let runtimeInitialized = false
let flushInterval: ReturnType<typeof setInterval> | undefined
let cleanupInterval: ReturnType<typeof setInterval> | undefined
let currentLogDateKey: string | undefined

const ensureLogDirectory = () => {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

const formatArgs = (args: Array<unknown>) =>
  args
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: null, colors: false })
      ),
    )
    .join(" ")

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const maybeUnref = (timer: ReturnType<typeof setInterval>) => {
  timer.unref()
}

const flushBuffer = (filePath: string) => {
  const buffer = logBuffers.get(filePath)
  if (!buffer) {
    return
  }

  logBuffers.delete(filePath)
  if (buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
    }
  })
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const closeLogFile = async (filePath: string): Promise<void> => {
  flushBuffer(filePath)
  const stream = logStreams.get(filePath)
  logStreams.delete(filePath)
  logBuffers.delete(filePath)

  if (!stream || stream.closed) {
    return
  }

  await new Promise<void>((resolve) => {
    stream.once("close", resolve)
    stream.end()
  })
}

const closePreviousDateLogFiles = (dateKey: string): void => {
  if (currentLogDateKey === undefined) {
    currentLogDateKey = dateKey
    return
  }
  if (currentLogDateKey === dateKey) {
    return
  }

  const filePaths = new Set([...logBuffers.keys(), ...logStreams.keys()])
  currentLogDateKey = dateKey
  for (const filePath of filePaths) {
    void closeLogFile(filePath).catch((error) => {
      console.warn("Failed to rotate handler log", error)
    })
  }
}

const cleanupOldLogs = async (): Promise<void> => {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    return
  }

  const now = Date.now()
  for (const entry of fs.readdirSync(logDir)) {
    const filePath = path.join(logDir, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile() || now - stats.mtimeMs <= LOG_RETENTION_MS) {
      continue
    }

    try {
      await closeLogFile(filePath)
    } catch (error) {
      console.warn(`Failed to close old handler log: ${filePath}`, error)
      continue
    }

    try {
      fs.rmSync(filePath)
    } catch (error) {
      console.warn(`Failed to remove old handler log: ${filePath}`, error)
    }
  }
}

const scheduleLogCleanup = (): void => {
  void cleanupOldLogs().catch((error) => {
    console.warn("Failed to clean up handler logs", error)
  })
}

const flushAndCloseLogStreams = () => {
  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }

  logStreams.clear()
  logBuffers.clear()
  currentLogDateKey = undefined
}

// Stops the background timers, flushes and closes all log streams, and resets
// runtime state so the logger can be initialized again. Runs on process exit
// and is also used by tests to release file handles before removing log dirs.
export const shutdownLoggerRuntime = () => {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = undefined
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }

  flushAndCloseLogStreams()
  runtimeInitialized = false
}

const initializeLoggerRuntime = () => {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  ensureLogDirectory()
  scheduleLogCleanup()

  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)
  maybeUnref(flushInterval)

  cleanupInterval = setInterval(scheduleLogCleanup, CLEANUP_INTERVAL_MS)
  maybeUnref(cleanupInterval)

  registerProcessCleanup(shutdownLoggerRuntime)
}

const getLogStream = (filePath: string): fs.WriteStream => {
  initializeLoggerRuntime()

  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    const createdStream = fs.createWriteStream(filePath, { flags: "a" })
    stream = createdStream
    logStreams.set(filePath, createdStream)

    createdStream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      if (logStreams.get(filePath) === createdStream) {
        logStreams.delete(filePath)
      }
    })
  }
  return stream
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer(filePath)
  }
}

type DebugLogger = Pick<ConsolaInstance, "debug">

type AsyncDebugValueFactory = () => Promise<unknown>

export const debugLazy = (
  logger: DebugLogger,
  factory: () => [unknown, ...Array<unknown>],
): void => {
  if (!state.verbose) {
    return
  }

  logger.debug(...factory())
}

export const debugJson = (
  logger: DebugLogger,
  label: string,
  value: unknown,
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value)])
}

export const debugJsonAsync = async (
  logger: DebugLogger,
  label: string,
  factory: AsyncDebugValueFactory,
): Promise<void> => {
  if (!state.verbose) {
    return
  }

  logger.debug(label, JSON.stringify(await factory()))
}

export const debugJsonTail = (
  logger: DebugLogger,
  label: string,
  { value, tailLength = 400 }: { value: unknown; tailLength?: number },
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value).slice(-tailLength)])
}

export const createHandlerLogger = (name: string): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  if (state.verbose) {
    instance.level = 5
  }
  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      initializeLoggerRuntime()

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(getLogDir(), `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(logObj.args as Array<unknown>)
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      closePreviousDateLogFiles(dateKey)
      appendLine(filePath, line)
    },
  })

  return instance
}
