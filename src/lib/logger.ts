import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { PATHS } from "./paths"

const LOG_RETENTION_DAYS = 7
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()

const ensureLogDirectory = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

const cleanupOldLogs = () => {
  if (!fs.existsSync(LOG_DIR)) {
    return
  }

  const now = Date.now()

  for (const entry of fs.readdirSync(LOG_DIR)) {
    const filePath = path.join(LOG_DIR, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile()) {
      continue
    }

    if (now - stats.mtimeMs > LOG_RETENTION_MS) {
      try {
        fs.rmSync(filePath)
      } catch {
        continue
      }
    }
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

const getLogStream = (filePath: string): fs.WriteStream => {
  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    stream = fs.createWriteStream(filePath, { flags: "a" })
    logStreams.set(filePath, stream)

    stream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      logStreams.delete(filePath)
    })
  }
  return stream
}

const flushBuffer = (filePath: string) => {
  const buffer = logBuffers.get(filePath)
  if (!buffer || buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
    }
  })

  logBuffers.set(filePath, [])
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
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

setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)

const cleanup = () => {
  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }
  logStreams.clear()
  logBuffers.clear()
}

process.on("exit", cleanup)
process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})
process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})

let lastCleanup = 0

export const createHandlerLogger = (name: string): ConsolaInstance => {
  ensureLogDirectory()

  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  instance.level = 5
  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      ensureLogDirectory()

      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        cleanupOldLogs()
        lastCleanup = Date.now()
      }

      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(LOG_DIR, `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(logObj.args as Array<unknown>)
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${
        message ? ` ${message}` : ""
      }`

      appendLine(filePath, line)
    },
  })

  return instance
}
