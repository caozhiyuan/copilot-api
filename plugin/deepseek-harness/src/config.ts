import z from "@deepseek-ai/schemastery"
import type { Volatile } from "@deepseek-ai/cordis"
import { credentialRef } from "@deepseek-ai/dsh-credentials"
import type { CredentialRef } from "@deepseek-ai/dsh-credentials"
import { LlmError, RetryPolicySchema } from "@deepseek-ai/dsh-llm"
import type { RetryPolicyConfig } from "@deepseek-ai/dsh-llm"
import type { AnthropicMessagesCompat, ModelThinkingLevel } from "@earendil-works/pi-ai"

export const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[]
export type Protocol = "openai-responses" | "anthropic-messages"
export type Modality = "text" | "image"
export type ReasoningEfforts = Readonly<Partial<Record<ModelThinkingLevel, string>>>

export interface ModelOverride {
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly input?: readonly Modality[]
  readonly reasoningEfforts?: false | ReasoningEfforts
  readonly compat?: Pick<AnthropicMessagesCompat, "forceAdaptiveThinking">
}

export interface Settings {
  baseURL: string
  apiKey?: string
  apiKeyEnv?: string
  protocol: Protocol
  headers: Record<string, string>
  modelRefreshInterval: number
  sessionAffinity: boolean
  modelOverrides: Readonly<Record<string, ModelOverride>>
  defaultContextWindow: number
  defaultMaxTokens: number
  modelDiscoveryTimeoutMs: number
  maxModelResponseBytes: number
  streamIdleTimeoutMs: number
  maxRequestImageBytes: number
  requestImagePixelBudget: number
  requestImageMaxBytes: number
  retryPolicy?: RetryPolicyConfig
}

export interface Config extends Omit<Settings, "modelOverrides"> {
  modelOverrides: Volatile<Settings["modelOverrides"]>
}
const positive = () => z.number().step(1).min(1)
const timer = () => positive().max(2_147_483_647)
const effortMap = z.object(Object.fromEntries(levels.map(level => [level, z.string()])))

// Secrets belong in Harness credentials, never in cordis.yml/cordis.patch.yml.
const fields = {
  baseURL: z.string().default("http://localhost:4141"),
  apiKey: z.string().role("credential-ref"),
  apiKeyEnv: z.string().role("credential-ref"),
  protocol: z.union(["openai-responses", "anthropic-messages"]).default("openai-responses"),
  headers: z.dict(z.string()).default({}),
  modelRefreshInterval: z.number().step(1).min(0).max(2_147_483_647).default(0),
  sessionAffinity: z.boolean().default(false),
  modelOverrides: z.dict(z.object({
    name: z.string(),
    contextWindow: positive(),
    maxTokens: positive(),
    input: z.array(z.union(["text", "image"])),
    reasoningEfforts: z.union([false, effortMap]),
    compat: z.object({ forceAdaptiveThinking: z.boolean() }),
  })).default({}),
  defaultContextWindow: positive().default(8192),
  defaultMaxTokens: positive().default(1024),
  modelDiscoveryTimeoutMs: timer().default(10_000),
  maxModelResponseBytes: positive().default(16 * 1024 * 1024),
  streamIdleTimeoutMs: timer().default(300_000),
  maxRequestImageBytes: positive().default(20 * 1024 * 1024),
  requestImagePixelBudget: positive().default(2048 * 2048),
  requestImageMaxBytes: positive().default(1024 * 1024),
  retryPolicy: RetryPolicySchema,
}
// Check the output contract while retaining Schemastery's distinct input type.
export const Options = z.object(fields) satisfies (input: never) => Settings

// Model metadata is editable live through Harness settings. Connection changes
// use the loader's normal remount, which also captures new headers and protocol.
export const Config = z.object({
  ...fields,
  modelOverrides: fields.modelOverrides.volatile(),
}) satisfies (input: never) => Config

/** Validate without including header values or secrets in diagnostics. */
export function connectionOf(config: Settings): { baseURL: string; keyRef: CredentialRef } {
  let url
  try { url = new URL(config.baseURL) }
  catch { throw new LlmError("copilot-api-provider: baseURL must be an HTTP(S) URL", "INVALID_CONFIG") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LlmError("copilot-api-provider: baseURL must be HTTP(S), without credentials, query, or fragment", "INVALID_CONFIG")
  }
  for (const [name, value] of Object.entries(config.headers)) {
    try { new Headers([[name, value]]) }
    catch { throw new LlmError("copilot-api-provider: invalid HTTP header name or multiline value", "INVALID_CONFIG") }
  }
  if (config.apiKey !== undefined && config.apiKeyEnv !== undefined && config.apiKey !== config.apiKeyEnv) {
    throw new LlmError("copilot-api-provider: apiKey and apiKeyEnv must name the same credential reference", "INVALID_CONFIG")
  }
  let keyRef: CredentialRef
  try { keyRef = credentialRef(config.apiKeyEnv ?? config.apiKey ?? "COPILOT_API_KEY") }
  catch { throw new LlmError("copilot-api-provider: apiKey must name a credential reference such as COPILOT_API_KEY", "INVALID_CONFIG") }
  const prefix = url.href.replace(/\/+$/u, "")
  return { baseURL: prefix.endsWith("/v1") ? prefix : `${prefix}/v1`, keyRef }
}
