import { LlmError } from "@deepseek-ai/dsh-llm"
import { levels } from "./config.js"

const messagesEfforts = new Set(["low", "medium", "high", "xhigh", "max"])
const record = value => typeof value === "object" && value !== null && !Array.isArray(value)
const positive = value => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
const label = value => typeof value === "string" && value.trim().length > 0 ? value : undefined

/** Map only capabilities that can actually be sent through the chosen protocol. */
export function reasoningEfforts(value, protocol) {
  if (!Array.isArray(value)) return false
  const offered = new Set(value.filter(entry => typeof entry === "string"))
  const efforts = {}
  for (const level of levels) {
    if (protocol === "anthropic-messages" && !messagesEfforts.has(level)) continue
    if (level === "off") {
      // Omission can enable a server default; only advertised `none` establishes off.
      if (offered.has("none")) efforts.off = "none"
    } else if (offered.has(level)) efforts[level] = level
  }
  return Object.keys(efforts).some(level => level !== "off") ? efforts : false
}

/** Parse the enriched /models response, preserving opaque, provider-prefixed IDs. */
export function parseModels(payload, config) {
  if (!record(payload) || !Array.isArray(payload.data)) {
    throw new LlmError("copilot-api-provider: /models must return a data array", "MODEL_DISCOVERY_FAILED")
  }
  const seen = new Set()
  return payload.data.map(entry => {
    if (!record(entry) || label(entry.id) === undefined) {
      throw new LlmError("copilot-api-provider: /models contains an entry without a model id", "MODEL_DISCOVERY_FAILED")
    }
    const id = entry.id
    if (seen.has(id)) throw new LlmError("copilot-api-provider: /models contains duplicate ids", "MODEL_DISCOVERY_FAILED")
    seen.add(id)
    const override = config.modelOverrides[id] ?? {}
    const contextWindow = override.contextWindow ?? positive(entry.context_window) ?? config.defaultContextWindow
    const efforts = override.reasoningEfforts ?? reasoningEfforts(entry.reasoning_efforts, config.protocol)
    /** @type {Record<string, string | null>} */
    const thinkingLevelMap = Object.fromEntries(levels.map(level => [level, null]))
    if (efforts !== false) {
      for (const [level, wire] of Object.entries(efforts)) {
        if (!levels.includes(level) || typeof wire !== "string" || wire.length === 0) continue
        if (config.protocol === "anthropic-messages" && (!messagesEfforts.has(level) || !messagesEfforts.has(wire))) continue
        if (level === "off" && wire !== "none") continue
        thinkingLevelMap[level] = wire
      }
    }
    const reasoning = Object.entries(thinkingLevelMap).some(([level, wire]) => level !== "off" && wire !== null)
    return {
      id,
      name: override.name ?? label(entry.name) ?? label(entry.display_name) ?? id,
      api: config.protocol,
      provider: "copilot-api",
      reasoning,
      thinkingLevelMap,
      input: override.input?.length > 0 ? [...override.input] : ["text", ...Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image") ? ["image"] : []],
      contextWindow,
      maxTokens: override.maxTokens ?? positive(entry.max_output_tokens) ?? Math.min(config.defaultMaxTokens, contextWindow),
      // No pricing is advertised by this endpoint. Harness still accounts for every token.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...config.protocol === "anthropic-messages" ? {
        compat: { forceAdaptiveThinking: reasoning, ...override.compat },
      } : {},
    }
  })
}
