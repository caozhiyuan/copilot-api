import type { PersistedTokenUsageEvent } from "../token-usage/store"

export interface PluginRequest {
  id: string
  traceId: string
  userAgent: string
  sessionId: string | null
  path: string
  port: number
  startedAt: number
  model: string | null
  actualModel: string | null
}

export interface GatewayPluginEvents {
  "request.start": PluginRequest
  "request.model": PluginRequest
  "request.actual_model": PluginRequest
  "request.session": PluginRequest
  "request.first_token": PluginRequest & { firstTokenMs: number }
  "request.end": PluginRequest & {
    durationMs: number
    firstTokenMs: number | null
    status: number
    outcome: "completed" | "cancelled" | "error"
  }
  "usage.recorded": PersistedTokenUsageEvent & {
    requestId: string | null
    userAgent: string
    sessionId: string | null
    actualModel: string
  }
}

export interface GatewayPluginApi {
  readonly version: 1
  readonly server: Readonly<{ pid: number; port: number }>
  on<Name extends keyof GatewayPluginEvents>(
    this: void,
    name: Name,
    handler: (
      event: Readonly<GatewayPluginEvents[Name]>,
    ) => void | Promise<void>,
  ): () => void
  log(this: void, message: string): void
}

export type GatewayPluginSetup = (
  api: GatewayPluginApi,
) =>
  | void
  | (() => void | Promise<void>)
  | Promise<void | (() => void | Promise<void>)>

export interface RequestEventObserver {
  id: string
  setModel(model: string): void
  setActualModel(model: string): void
  setSessionId(sessionId: string): void
  recordFirstToken(): void
  recordUsage(event: PersistedTokenUsageEvent): void
}
