import { randomUUID } from "node:crypto"
import type { MiddlewareHandler } from "hono"

import type {
  GatewayPlugins,
  PluginRequest,
  GatewayPluginEvents,
} from "./gateway-plugins"
import { requestContext, type RequestTiming } from "./request-context"
import { enqueueTokenUsageTiming } from "./token-usage/store"

const TRACKED = /\/(chat\/completions|responses|messages|alpha\/search)$/

// Called only where the handler already has a parsed payload.
export function setPluginRequestModel(model: string): void {
  requestContext.getStore()?.pluginRequest?.setModel(model)
}

export function requestEventsMiddleware(
  plugins: GatewayPlugins | undefined,
  port: number,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST" || !TRACKED.test(c.req.path)) {
      return await next()
    }
    const store = requestContext.getStore()
    if (!store) return await next()
    const started = performance.now()
    const info: PluginRequest = {
      id: randomUUID(),
      traceId: store.traceId,
      userAgent: store.userAgent,
      sessionId: store.sessionAffinity?.trim() || null,
      path: c.req.path,
      port,
      startedAt: Date.now(),
      model: null,
      actualModel: null,
    }
    let finished = false
    const signal = c.req.raw.signal
    const timing: RequestTiming = {
      id: info.id,
      firstTokenMs: null,
      durationMs: null,
      outcome: null,
      hasUsage: false,
      recordFirstToken: () => {
        if (finished || timing.firstTokenMs !== null) return
        timing.firstTokenMs = performance.now() - started
        plugins?.publish("request.first_token", {
          ...info,
          firstTokenMs: timing.firstTokenMs,
        })
      },
    }
    store.requestTiming = timing
    let status = 0
    const finish = (outcome: GatewayPluginEvents["request.end"]["outcome"]) => {
      if (finished) return
      finished = true
      timing.durationMs = performance.now() - started
      timing.outcome = outcome
      if (timing.hasUsage) enqueueTokenUsageTiming(timing)
      plugins?.publish("request.end", {
        ...info,
        durationMs: timing.durationMs,
        firstTokenMs: timing.firstTokenMs,
        status,
        outcome,
      })
      signal.removeEventListener("abort", abort)
    }
    const abort = () => finish("cancelled")
    if (plugins?.enabled)
      store.pluginRequest = {
        id: info.id,
        setModel: (model) => {
          if (
            finished
            || typeof model !== "string"
            || !model
            || info.model === model
          )
            return
          info.model = model
          plugins.publish("request.model", info)
        },
        setActualModel: (model) => {
          if (
            finished
            || typeof model !== "string"
            || !model
            || info.actualModel === model
          )
            return
          info.actualModel = model
          plugins.publish("request.actual_model", info)
        },
        setSessionId: (sessionId) => {
          if (!sessionId || info.sessionId === sessionId) return
          info.sessionId = sessionId
          if (!finished) plugins.publish("request.session", info)
        },
        recordFirstToken: timing.recordFirstToken,
        recordUsage: (event) =>
          plugins.publish("usage.recorded", {
            ...event,
            requestId: info.id,
            userAgent: info.userAgent,
            sessionId: event.session_id || null,
            actualModel: event.model,
          }),
      }
    plugins?.publish("request.start", info)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      await next()
      const response = c.res
      status = response.status
      if (!response.body) {
        finish(status >= 400 ? "error" : "completed")
        return
      }
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read()
            if (result.done) {
              finish(status >= 400 ? "error" : "completed")
              controller.close()
              reader.releaseLock()
              return
            }
            controller.enqueue(result.value)
          } catch (error) {
            finish("error")
            controller.error(error)
            reader.releaseLock()
          }
        },
        async cancel(reason) {
          finish("cancelled")
          try {
            await reader.cancel(reason)
          } finally {
            reader.releaseLock()
          }
        },
      })
      c.res = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      finish("error")
      throw error
    }
  }
}
