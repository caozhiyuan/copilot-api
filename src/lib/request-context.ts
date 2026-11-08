import { AsyncLocalStorage } from "node:async_hooks"
import type { RequestEventObserver } from "./types/gateway-plugins"
import type { SubagentMarker } from "./subagent"

export interface RequestTiming {
  id: string
  firstTokenMs: number | null
  durationMs: number | null
  outcome: "completed" | "cancelled" | "error" | null
  protocolFailed?: boolean
  hasUsage: boolean
  recordFirstToken: () => void
}

export interface RequestContext {
  traceId: string
  startTime: number
  userAgent: string
  sessionAffinity: string | undefined
  rootSessionId?: string
  isClaudeCode?: boolean
  parentSessionId: string | undefined
  subagent?: SubagentMarker | null
  pluginRequest?: RequestEventObserver
  requestTiming?: RequestTiming
}

const TRACE_ID_MAX_LENGTH = 64
const TRACE_ID_PATTERN = /^\w[\w.-]*$/

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

export const requestContext = {
  getStore: () => asyncLocalStorage.getStore(),
  run: <T>(context: RequestContext, callback: () => T) =>
    asyncLocalStorage.run(context, callback),
}

// Observe the final target at upstream dispatch, after mapping and overrides.
export function formatPluginActualModel(
  model: string,
  provider?: string | null,
): string {
  return !model || !provider || provider === "github-copilot" ?
      model
    : `${provider}/${model}`
}

export function setPluginRequestActualModel(
  model: string,
  provider?: string,
): void {
  requestContext
    .getStore()
    ?.pluginRequest?.setActualModel(formatPluginActualModel(model, provider))
}

export function generateTraceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

export function resolveTraceId(traceId: string | null | undefined): string {
  const candidate = traceId?.trim()

  if (
    !candidate
    || candidate.length > TRACE_ID_MAX_LENGTH
    || !TRACE_ID_PATTERN.test(candidate)
  ) {
    return generateTraceId()
  }

  return candidate
}
