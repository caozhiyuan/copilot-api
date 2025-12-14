/* eslint-disable unicorn/require-post-message-target-origin */

import { parentPort, workerData } from "node:worker_threads"

import { runServer } from "../../src/start"

type WorkerData = {
  port: number
  verbose: boolean
  accountType: string
  rateLimitSeconds: number | null
  rateLimitWait: boolean
  githubToken?: string
  proxyEnv: boolean
  showToken: boolean
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1_000)
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (res.ok) return
      } finally {
        clearTimeout(timeout)
      }
    } catch {
      // ignore and retry
    }

    await sleep(200)
  }

  throw new Error(`Server did not become ready in ${timeoutMs}ms`)
}

if (!parentPort) {
  throw new Error("Missing parentPort (not running as a worker thread)")
}

const data = workerData as WorkerData

process.on("uncaughtException", (error) => {
  if (!parentPort) return
  const { message, stack } = serializeError(error)
  parentPort.postMessage({ type: "error", message, stack })
})

process.on("unhandledRejection", (reason) => {
  if (!parentPort) return
  const { message, stack } = serializeError(reason)
  parentPort.postMessage({ type: "error", message, stack })
})

process.env.HOST = "127.0.0.1"
process.env.NODE_ENV ??= "production"

parentPort.postMessage({ type: "starting", port: data.port })

try {
  await runServer({
    port: data.port,
    verbose: data.verbose,
    accountType: data.accountType,
    manual: false,
    rateLimit: data.rateLimitSeconds ?? undefined,
    rateLimitWait: data.rateLimitWait,
    githubToken: data.githubToken,
    claudeCode: false,
    showToken: data.showToken,
    proxyEnv: data.proxyEnv,
  })

  const endpoint = `http://localhost:${data.port}`
  await waitForReady(`http://127.0.0.1:${data.port}/`, 60_000)
  parentPort.postMessage({ type: "ready", endpoint })
} catch (error) {
  const { message, stack } = serializeError(error)
  parentPort.postMessage({ type: "error", message, stack })
}
