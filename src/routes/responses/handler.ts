import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import { accountsManager } from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import { getAliasTargetSet, getConfig } from "~/lib/config"
import {
  computeDiff,
  extractErrorDetails,
  toAccountContext,
} from "~/lib/handler-utils"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  extractResponsesUsageFromResult,
  extractResponsesUsageFromStreamEvent,
  getClientIpInfo,
  getRequestHistoryStore,
  type NormalizedUsage,
} from "~/lib/request-history"
import { state } from "~/lib/state"
import {
  generateRequestIdFromPayload,
  getUUID,
  parseUserIdMetadata,
} from "~/lib/utils"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

// eslint-disable-next-line max-lines-per-function
export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const store = getRequestHistoryStore()
  const request = buildRequestContext(c)

  const payload = await c.req.json<ResponsesPayload>()
  const clientModel = payload.model
  logger.debug("Responses request payload:", JSON.stringify(payload))

  // Remove web_search tool as it's not supported by GitHub Copilot
  removeWebSearchTool(payload)
  compactInputByLatestCompaction(payload)

  const streamRequested = Boolean(payload.stream)
  const { initiator: initialInitiator } = getResponsesRequestOptions(payload)
  const userId = (payload.metadata as { user_id?: string } | null | undefined)
    ?.user_id
  const { safetyIdentifier, sessionId: promptCacheKey } =
    parseUserIdMetadata(userId)
  const normalizedSafetyIdentifier = safetyIdentifier ?? undefined
  const normalizedPromptCacheKey = promptCacheKey ?? undefined

  request.userId = userId
  request.safetyIdentifier = normalizedSafetyIdentifier
  request.promptCacheKey = normalizedPromptCacheKey
  request.initiator = initialInitiator

  const blockedTargets = getAliasTargetSet()
  if (blockedTargets.has(clientModel.toLowerCase())) {
    recordSelectionFailure(store, {
      request,
      stream: streamRequested,
      clientModel,
      reason: "MODEL_NOT_SUPPORTED",
    })

    return selectionFailureResponse(c, {
      reason: "MODEL_NOT_SUPPORTED",
      message:
        "This model is only available via an alias. Please use the alias model name.",
    })
  }

  const selection = await accountsManager.selectAccountForRequest(
    [
      {
        modelId: clientModel,
        endpoint: RESPONSES_ENDPOINT,
      },
    ],
    {
      promptCacheKey: normalizedPromptCacheKey,
      safetyIdentifier: normalizedSafetyIdentifier,
    },
  )

  if (!selection.ok) {
    recordSelectionFailure(store, {
      request,
      stream: streamRequested,
      clientModel,
      reason: selection.reason,
    })

    return selectionFailureResponse(c, {
      reason: selection.reason,
    })
  }

  const { account, selectedModel } = selection

  const upstreamPayload = { ...payload, model: selectedModel.id }
  useFunctionApplyPatch(upstreamPayload)
  applyResponsesApiContextManagement(
    upstreamPayload,
    selectedModel.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(upstreamPayload)

  const premiumRemainingBefore = account.premiumRemaining
  const premiumUnlimitedBefore = account.unlimited

  const { vision, initiator } = getResponsesRequestOptions(upstreamPayload)
  request.initiator = initiator
  if (state.manualApprove) await awaitApproval()

  const accountCtx = toAccountContext(account)
  const upstreamRequestId = generateRequestIdFromPayload({
    messages: upstreamPayload.input,
  })
  const upstreamSessionId = getUUID(upstreamRequestId)
  request.upstreamRequestId = upstreamRequestId
  request.upstreamSessionId = upstreamSessionId

  if (streamRequested) {
    return handleStreamingResponses({
      c,
      store,
      request,
      payload: upstreamPayload,
      selection,
      clientModel,
      accountCtx,
      vision,
      initiator,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
    })
  }

  return handleNonStreamingResponses({
    c,
    store,
    request,
    payload: upstreamPayload,
    selection,
    clientModel,
    accountCtx,
    vision,
    initiator,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  })
}

type AccountSelection = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>

type AccountSelectionOk = Extract<AccountSelection, { ok: true }>

type AccountSelectionErr = Extract<AccountSelection, { ok: false }>

type RequestContext = {
  requestId: string
  startedAtMs: number

  method: string
  path: string

  clientIp?: string
  clientIpSource?: string
  userAgent?: string

  userId?: string
  safetyIdentifier?: string
  promptCacheKey?: string
  initiator?: "agent" | "user"
  upstreamRequestId?: string
  upstreamSessionId?: string
}

type Store = ReturnType<typeof getRequestHistoryStore>

type RequestLogInsert = Parameters<Store["insert"]>[0]

type StreamSseStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

function buildRequestContext(c: Context): RequestContext {
  const requestId = randomUUID()
  const startedAtMs = Date.now()

  const method = c.req.raw.method
  const path = new URL(c.req.url, "http://local").pathname

  const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
  const userAgent = c.req.header("user-agent") ?? undefined

  return {
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
  }
}

function insertRequestLog(
  store: Store,
  request: RequestContext,
  record: Omit<
    RequestLogInsert,
    | "requestId"
    | "startedAtMs"
    | "method"
    | "path"
    | "clientIp"
    | "clientIpSource"
    | "userAgent"
  >,
): void {
  store.insert({
    requestId: request.requestId,
    startedAtMs: request.startedAtMs,
    method: request.method,
    path: request.path,
    clientIp: request.clientIp,
    clientIpSource: request.clientIpSource,
    userAgent: request.userAgent,
    userId: request.userId,
    safetyIdentifier: request.safetyIdentifier,
    promptCacheKey: request.promptCacheKey,
    initiator: request.initiator,
    upstreamRequestId: request.upstreamRequestId,
    ...record,
  })
}

function recordSelectionFailure(
  store: Store,
  params: {
    request: RequestContext
    stream: boolean
    clientModel: string
    reason: AccountSelectionErr["reason"]
  },
): void {
  const { request, stream, clientModel, reason } = params

  const finishedAtMs = Date.now()

  insertRequestLog(store, request, {
    finishedAtMs,
    durationMs: finishedAtMs - request.startedAtMs,
    upstreamEndpoint: RESPONSES_ENDPOINT,
    stream,
    clientModel,
    httpStatus: reason === "MODEL_NOT_SUPPORTED" ? 400 : 429,
    selectionFailureReason: reason,
  })
}

function selectionFailureResponse(
  c: Context,
  params: {
    reason: AccountSelectionErr["reason"]
    message?: string
  },
) {
  const { reason, message } = params

  if (reason === "MODEL_NOT_SUPPORTED") {
    return c.json(
      {
        error: {
          message:
            message
            ?? "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  return c.json(
    {
      error: {
        message:
          "All accounts have exhausted their quota. Please wait for quota refresh or add additional accounts.",
        type: "rate_limit_error",
      },
    },
    429,
  )
}

function extractUsageFromChunkData(
  data: string | undefined,
): NormalizedUsage | undefined {
  if (!data) return undefined

  try {
    const event = JSON.parse(data) as ResponseStreamEvent
    const usage = extractResponsesUsageFromStreamEvent(event)
    return usage.usageJson ? usage : undefined
  } catch {
    return undefined
  }
}

type StreamChunk = {
  id?: string
  event?: string
  data?: string
}

function getStreamChunkFields(chunk: unknown): StreamChunk {
  const c = chunk as StreamChunk
  return {
    id: c.id,
    event: c.event,
    data: c.data,
  }
}

async function handleStreamingResponses(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ResponsesPayload
  selection: AccountSelectionOk
  clientModel: string
  accountCtx: Parameters<typeof createResponses>[2]
  vision: boolean
  initiator: "agent" | "user"
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    clientModel,
    accountCtx,
    vision,
    initiator,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  } = params

  let response: Awaited<ReturnType<typeof createResponses>>

  try {
    response = await createResponses(
      payload,
      {
        vision,
        initiator,
        upstreamRequestId: request.upstreamRequestId,
        sessionId: request.upstreamSessionId,
      },
      accountCtx,
    )
    selection.confirmAffinity?.()
  } catch (error) {
    return handleUpstreamCreateError({
      store,
      request,
      selection,
      clientModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      error,
    })
  }

  if (isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")

    return streamSSE(c, (stream) =>
      streamResponsesAndLog({
        stream,
        response,
        store,
        request,
        selection,
        clientModel,
        premiumRemainingBefore,
        premiumUnlimitedBefore,
      }),
    )
  }

  return handleNonStreamingUpstreamResult({
    c,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    result: response,
  })
}

async function handleUpstreamCreateError(params: {
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  error: unknown
}): Promise<never> {
  const {
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    error,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  const finishedAtMs = Date.now()
  const details = extractErrorDetails(error)

  if (details.unauthorized) {
    accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
  }

  await accountsManager.finalizeQuota(account, reservation)

  const premiumRemainingAfter = account.premiumRemaining
  const premiumUnlimitedAfter = account.unlimited

  insertRequestLog(store, request, {
    finishedAtMs,
    durationMs: finishedAtMs - request.startedAtMs,
    upstreamEndpoint: endpoint,
    stream: true,
    accountId: account.id,
    accountType: account.accountType,
    costUnits,
    clientModel,
    upstreamModel: selectedModel.id,
    premiumRemainingBefore,
    premiumRemainingAfter,
    premiumRemainingDiff: computeDiff(
      premiumRemainingBefore,
      premiumRemainingAfter,
    ),
    premiumUnlimitedBefore,
    premiumUnlimitedAfter,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
  })

  throw error
}

async function handleNonStreamingUpstreamResult(params: {
  c: Context
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  result: ResponsesResult
}): Promise<Response> {
  const {
    c,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    result,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  let httpStatus = 200
  const usage: NormalizedUsage = extractResponsesUsageFromResult(result)
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const finishedAtMs = Date.now()

  try {
    logger.debug(
      "Forwarding native Responses result:",
      JSON.stringify(result).slice(-400),
    )
    return c.json(result)
  } catch (error) {
    const details = extractErrorDetails(error)
    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    throw error
  } finally {
    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

    insertRequestLog(store, request, {
      finishedAtMs,
      durationMs: finishedAtMs - request.startedAtMs,
      upstreamEndpoint: endpoint,
      stream: false,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      clientModel,
      upstreamModel: selectedModel.id,
      ...usage,
      premiumRemainingBefore,
      premiumRemainingAfter,
      premiumRemainingDiff: computeDiff(
        premiumRemainingBefore,
        premiumRemainingAfter,
      ),
      premiumUnlimitedBefore,
      premiumUnlimitedAfter,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

async function streamResponsesAndLog(params: {
  stream: StreamSseStream
  response: AsyncIterable<unknown>
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
}): Promise<void> {
  const {
    stream,
    response,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  const idTracker = createStreamIdTracker()
  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  try {
    for await (const chunk of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - request.startedAtMs
      }

      const { id, event, data } = getStreamChunkFields(chunk)
      const processedData = fixStreamIds(data ?? "", event, idTracker)

      const usage = extractUsageFromChunkData(processedData)
      if (usage) {
        lastUsage = usage
      }

      logger.debug("Responses stream chunk:", JSON.stringify(chunk))

      await stream.writeSSE({
        id,
        event,
        data: processedData,
      })
    }
  } catch (error) {
    const details = extractErrorDetails(error)
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    logger.warn("Responses streaming error:", error)
  } finally {
    const finishedAtMs = Date.now()

    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

    insertRequestLog(store, request, {
      finishedAtMs,
      durationMs: finishedAtMs - request.startedAtMs,
      ttfbMs,
      upstreamEndpoint: endpoint,
      stream: true,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      clientModel,
      upstreamModel: selectedModel.id,
      ...lastUsage,
      premiumRemainingBefore,
      premiumRemainingAfter,
      premiumRemainingDiff: computeDiff(
        premiumRemainingBefore,
        premiumRemainingAfter,
      ),
      premiumUnlimitedBefore,
      premiumUnlimitedAfter,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

async function handleNonStreamingResponses(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ResponsesPayload
  selection: AccountSelectionOk
  clientModel: string
  accountCtx: Parameters<typeof createResponses>[2]
  vision: boolean
  initiator: "agent" | "user"
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    clientModel,
    accountCtx,
    vision,
    initiator,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  } = params
  const { account, reservation, selectedModel, endpoint, costUnits } = selection
  let httpStatus = 200
  let usage: NormalizedUsage = {}
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let finishedAtMs: number | undefined
  try {
    const response = await createResponses(
      payload,
      {
        vision,
        initiator,
        upstreamRequestId: request.upstreamRequestId,
        sessionId: request.upstreamSessionId,
      },
      accountCtx,
    )
    selection.confirmAffinity?.()
    finishedAtMs = Date.now()
    const streamResponse = handleUnexpectedResponsesStream(c, response)
    if (streamResponse) {
      return streamResponse
    }
    const result = response as ResponsesResult
    usage = extractResponsesUsageFromResult(result)
    logger.debug(
      "Forwarding native Responses result:",
      JSON.stringify(result).slice(-400),
    )
    return c.json(result)
  } catch (error) {
    finishedAtMs = Date.now()
    const details = extractErrorDetails(error)
    httpStatus = details.httpStatus
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    if (details.unauthorized) {
      accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
    }
    throw error
  } finally {
    const finishedAtMsFinal = finishedAtMs ?? Date.now()

    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

    insertRequestLog(store, request, {
      finishedAtMs: finishedAtMsFinal,
      durationMs: finishedAtMsFinal - request.startedAtMs,
      upstreamEndpoint: endpoint,
      stream: false,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      clientModel,
      upstreamModel: selectedModel.id,
      ...usage,
      premiumRemainingBefore,
      premiumRemainingAfter,
      premiumRemainingDiff: computeDiff(
        premiumRemainingBefore,
        premiumRemainingAfter,
      ),
      premiumUnlimitedBefore,
      premiumUnlimitedAfter,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

function handleUnexpectedResponsesStream(
  c: Context,
  response: Awaited<ReturnType<typeof createResponses>>,
): Response | null {
  if (!isAsyncIterable(response)) {
    return null
  }

  // Defensive guard: upstream returned stream unexpectedly.
  logger.debug("Forwarding native Responses stream (unexpected)")

  return streamSSE(c, async (stream) => {
    const idTracker = createStreamIdTracker()

    for await (const chunk of response) {
      const { id, event, data } = getStreamChunkFields(chunk)
      const processedData = fixStreamIds(data ?? "", event, idTracker)
      await stream.writeSSE({
        id,
        event,
        data: processedData,
      })
    }
  })
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const enabled = config.useFunctionApplyPatch ?? true
  if (!enabled) return

  logger.debug("Using function tool apply_patch for responses")
  if (Array.isArray(payload.tools)) {
    const toolsArr = payload.tools
    for (let i = 0; i < toolsArr.length; i++) {
      const t = toolsArr[i]
      if (t.type === "custom" && t.name === "apply_patch") {
        toolsArr[i] = {
          type: "function",
          name: t.name,
          description: "Use the `apply_patch` tool to edit files",
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "The entire contents of the apply_patch command",
              },
            },
            required: ["input"],
          },
          strict: false,
        }
      }
    }
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}
