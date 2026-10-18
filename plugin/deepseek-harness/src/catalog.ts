import { LlmError } from "@deepseek-ai/dsh-llm"
import { gatewayHeaders } from "./transport.ts"
import { parseModels } from "./models.ts"
import { createProfile } from "./provider.ts"
import type { Settings } from "./config.ts"
import type { DiscoveredModel } from "./models.ts"
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai"

async function waitForDiscovery(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new LlmError("copilot-api-provider: model discovery cancelled", "ABORTED"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try { await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener("abort", onAbort) }
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new LlmError("copilot-api-provider: model catalog exceeds maxModelResponseBytes", "MODEL_DISCOVERY_FAILED")
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new LlmError("copilot-api-provider: empty model response", "MODEL_DISCOVERY_FAILED")
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > limit) throw new LlmError("copilot-api-provider: model catalog exceeds maxModelResponseBytes", "MODEL_DISCOVERY_FAILED")
      chunks.push(next.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }
    catch { throw new LlmError("copilot-api-provider: /models returned invalid JSON", "MODEL_DISCOVERY_FAILED") }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/** Immutable model generations: refresh failures never withdraw a working catalog. */
export class CopilotModelCatalog {
  private readonly config: Settings
  private readonly baseURL: string
  private readonly resolveKey: () => Promise<string>
  private readonly changed: (error?: string) => void
  private readonly warn: (message: string) => void
  private readonly lifecycle = new AbortController()
  private readonly emptyProfiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map()
  private snapshot: { models: readonly DiscoveredModel[]; profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> } | undefined
  private inFlight: Promise<void> | undefined

  constructor(config: Settings, baseURL: string, resolveKey: () => Promise<string>, changed: (error?: string) => void, warn: (message: string) => void) {
    this.config = config
    this.baseURL = baseURL
    this.resolveKey = resolveKey
    this.changed = changed
    this.warn = warn
  }
  get profiles(): ReadonlyMap<string, ResolvedPiAiProviderProfile> { return this.snapshot?.profiles ?? this.emptyProfiles }
  get models(): readonly DiscoveredModel[] | undefined { return this.snapshot?.models }

  async ensure(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.snapshot === undefined) await waitForDiscovery(this.refresh(), signal)
  }
  refresh(signal?: AbortSignal): Promise<void> {
    this.lifecycle.signal.throwIfAborted()
    signal?.throwIfAborted()
    this.inFlight ??= this.load().finally(() => { this.inFlight = undefined })
    return signal === undefined ? this.inFlight : waitForDiscovery(this.inFlight, signal)
  }
  private async load(): Promise<void> {
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
  async dispose(): Promise<void> {
    this.lifecycle.abort()
    try { await this.inFlight }
    catch { /* Lifecycle disposal owns this cancelled discovery. */ }
  }
}
