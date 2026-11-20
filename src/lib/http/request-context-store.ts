import { AsyncLocalStorage } from "node:async_hooks"

import type { SubagentMarker } from "./subagent"
import type { GatewayApiKeyConfig } from "../types/api-key"
import type { RequestEventObserver } from "../types/gateway-plugins"
import type { RequestTiming } from "../types/token-usage"

export interface RequestContext {
  apiKey?: GatewayApiKeyConfig
  apiKeyUsageIds?: Set<string>
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

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

export const requestContext = {
  getStore: () => asyncLocalStorage.getStore(),
  run: <T>(context: RequestContext, callback: () => T) =>
    asyncLocalStorage.run(context, callback),
}
