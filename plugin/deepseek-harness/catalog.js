import { LlmError } from "@deepseek-ai/dsh-llm"
import { gatewayHeaders } from "./transport.js"
import { parseModels } from "./models.js"
import { createProfile } from "./provider.js"

async function waitForDiscovery(operation, signal) {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  let onAbort
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(new LlmError("copilot-api-provider: model discovery cancelled", "ABORTED"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try { await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener("abort", onAbort) }
}

async function boundedJson(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new LlmError("copilot-api-provider: model catalog exceeds maxModelResponseBytes", "MODEL_DISCOVERY_FAILED")
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new LlmError("copilot-api-provider: empty model response", "MODEL_DISCOVERY_FAILED")
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > limit) throw new LlmError("copilot-api-provider: model catalog exceeds maxModelResponseBytes", "MODEL_DISCOVERY_FAILED")
      chunks.push(next.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    catch { throw new LlmError("copilot-api-provider: /models returned invalid JSON", "MODEL_DISCOVERY_FAILED") }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/** Immutable model generations: refresh failures never withdraw a working catalog. */
export class CopilotModelCatalog {
  constructor(config, baseURL, resolveKey, changed, warn) {
    this.config = config
    this.baseURL = baseURL
    this.resolveKey = resolveKey
    this.changed = changed
    this.warn = warn
    this.lifecycle = new AbortController()
    this.emptyProfiles = new Map()
    this.snapshot = undefined
    this.inFlight = undefined
  }
  get profiles() { return this.snapshot?.profiles ?? this.emptyProfiles }
  get models() { return this.snapshot?.models }

  async ensure(signal) {
    signal?.throwIfAborted()
    if (this.snapshot === undefined) await waitForDiscovery(this.refresh(), signal)
  }
  refresh(signal) {
    this.lifecycle.signal.throwIfAborted()
    signal?.throwIfAborted()
    this.inFlight ??= this.load().finally(() => { this.inFlight = undefined })
    return signal === undefined ? this.inFlight : waitForDiscovery(this.inFlight, signal)
  }
  async load() {
    const config = { ...this.config }
    const timer = AbortSignal.timeout(config.modelDiscoveryTimeoutMs)
    const signal = AbortSignal.any([this.lifecycle.signal, timer])
    try {
      const apiKey = await this.resolveKey()
      signal.throwIfAborted()
      const response = await fetch(`${this.baseURL}/models`, {
        headers: gatewayHeaders(config, apiKey), signal, redirect: "error",
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new LlmError(`copilot-api-provider: model discovery failed (HTTP ${response.status}); check the gateway and credential`, "MODEL_DISCOVERY_FAILED")
      }
      const models = parseModels(await boundedJson(response, config.maxModelResponseBytes), config)
      const profiles = models.length === 0 ? new Map() : new Map([["copilot-api", createProfile(config, this.baseURL, models)]])
      signal.throwIfAborted()
      this.snapshot = { models, profiles }
      this.changed()
    } catch (error) {
      if (this.lifecycle.signal.aborted) throw new LlmError("copilot-api-provider: plugin disposed", "ABORTED")
      const failure = error instanceof LlmError ? error : new LlmError(
        "copilot-api-provider: model discovery failed; check the gateway URL, credential, and model metadata", "MODEL_DISCOVERY_FAILED",
      )
      const message = this.snapshot === undefined ? failure.message : `${failure.message}; using the last successful catalog`
      this.warn(message)
      this.changed(message)
      if (this.snapshot === undefined) throw failure
    }
  }
  async dispose() {
    this.lifecycle.abort()
    try { await this.inFlight }
    catch { /* Lifecycle disposal owns this cancelled discovery. */ }
  }
}
