import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"
import { randomUUID } from "node:crypto"

import { accountsManager } from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import { getAliasTargetSet } from "~/lib/config"
import {
  computeDiff,
  extractErrorDetails,
  toAccountContext,
} from "~/lib/handler-utils"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  getClientIpInfo,
  getRequestHistoryStore,
  normalizeChatCompletionsUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  generateRequestIdFromPayload,
  getUUID,
  isNullish,
  parseUserIdMetadata,
} from "~/lib/utils"
import {
  createChatCompletions,
  getChatInitiator,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const store = getRequestHistoryStore()
  const request = buildRequestContext(c)

  const payload = await c.req.json<ChatCompletionsPayload>()
  const clientModel = payload.model
  const streamRequested = Boolean(payload.stream)

  const initiator = getChatInitiator(payload.messages)
  const userId = payload.user ?? undefined
  const { safetyIdentifier, sessionId: promptCacheKey } =
    parseUserIdMetadata(userId)
  const normalizedSafetyIdentifier = safetyIdentifier ?? undefined
  const normalizedPromptCacheKey = promptCacheKey ?? undefined

  request.userId = userId
  request.safetyIdentifier = normalizedSafetyIdentifier
  request.promptCacheKey = normalizedPromptCacheKey
  request.initiator = initiator

  const blockedTargets = getAliasTargetSet()
  if (blockedTargets.has(clientModel.toLowerCase())) {
    recordSelectionFailure(store, {
      request,
      clientModel,
      stream: streamRequested,
      reason: "MODEL_NOT_SUPPORTED",
    })

    return selectionFailureResponse(c, {
      clientModel,
      reason: "MODEL_NOT_SUPPORTED",
    })
  }

  logger.debug("Request payload:", JSON.stringify(payload).slice(-400))

  const upstreamRequestId = generateRequestIdFromPayload(payload)

  const selection = await accountsManager.selectAccountForRequest(
    [
      {
        modelId: clientModel,
        endpoint: CHAT_COMPLETIONS_ENDPOINT,
      },
    ],
    {
      requestId: upstreamRequestId,
    },
  )

  if (!selection.ok) {
    recordSelectionFailure(store, {
      request,
      clientModel,
      stream: streamRequested,
      reason: selection.reason,
    })

    return selectionFailureResponse(c, {
      clientModel,
      reason: selection.reason,
    })
  }

  const { account, selectedModel } = selection

  request.affinityHit = selection.affinityHit
  request.affinityCacheKey = selection.affinityCacheKey

  const upstreamPayload = { ...payload, model: selectedModel.id }

  const premiumRemainingBefore = account.premiumRemaining
  const premiumUnlimitedBefore = account.unlimited

  await logTokenCountForRequest({ payload: upstreamPayload, selectedModel })

  if (state.manualApprove) await awaitApproval()

  const payloadWithMaxTokens = applyDefaultMaxTokens(
    upstreamPayload,
    selectedModel,
  )

  const accountCtx = toAccountContext(account)
  const upstreamSessionId = getUUID(upstreamRequestId)
  request.upstreamRequestId = upstreamRequestId
  request.upstreamSessionId = upstreamSessionId

  if (streamRequested) {
    return handleStreamingRequest({
      c,
      store,
      request,
      payload: payloadWithMaxTokens,
      selection,
      accountCtx,
      clientModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
    })
  }

  return handleNonStreamingRequest({
    c,
    store,
    request,
    payload: payloadWithMaxTokens,
    selection,
    accountCtx,
    clientModel,
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

  affinityHit?: boolean
  affinityCacheKey?: string
}

type Store = ReturnType<typeof getRequestHistoryStore>

type RequestLogInsert = Parameters<Store["insert"]>[0]

type ChatCompletionsResult = Awaited<ReturnType<typeof createChatCompletions>>

type ChatCompletionsStream = Exclude<
  ChatCompletionsResult,
  ChatCompletionResponse
>

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
    affinityHit: request.affinityHit,
    affinityCacheKey: request.affinityCacheKey,
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
    upstreamEndpoint: CHAT_COMPLETIONS_ENDPOINT,
    stream,
    clientModel,
    httpStatus: reason === "MODEL_NOT_SUPPORTED" ? 400 : 429,
    selectionFailureReason: reason,
  })
}

function selectionFailureResponse(
  c: Context,
  params: {
    clientModel: string
    reason: AccountSelectionErr["reason"]
  },
) {
  const { clientModel, reason } = params

  if (reason === "MODEL_NOT_SUPPORTED") {
    return c.json(
      {
        error: {
          message: `Model "${clientModel}" is not available for any configured account.`,
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

async function logTokenCountForRequest(params: {
  payload: ChatCompletionsPayload
  selectedModel: AccountSelectionOk["selectedModel"]
}) {
  try {
    const tokenCount = await getTokenCount(params.payload, params.selectedModel)
    logger.info("Current token count:", tokenCount)
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }
}

function applyDefaultMaxTokens(
  payload: ChatCompletionsPayload,
  selectedModel: AccountSelectionOk["selectedModel"],
): ChatCompletionsPayload {
  if (!isNullish(payload.max_tokens)) {
    return payload
  }

  const updated = {
    ...payload,
    max_tokens: selectedModel.capabilities.limits.max_output_tokens,
  }

  logger.debug("Set max_tokens to:", JSON.stringify(updated.max_tokens))

  return updated
}

async function handleStreamingRequest(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ChatCompletionsPayload
  selection: AccountSelectionOk
  accountCtx: Parameters<typeof createChatCompletions>[1]
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    accountCtx,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  } = params

  let response: ChatCompletionsResult

  try {
    response = await createChatCompletions(payload, accountCtx, {
      upstreamRequestId: request.upstreamRequestId,
      sessionId: request.upstreamSessionId,
    })
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

  // A defensive guard: stream requested, but upstream returned a non-stream response.
  if (isNonStreaming(response)) {
    return handleNonStreamingUpstreamResponse({
      c,
      store,
      request,
      selection,
      clientModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      response,
    })
  }

  logger.debug("Streaming response")

  return streamSSE(c, (stream) =>
    streamChatCompletionsAndLog({
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

async function handleNonStreamingUpstreamResponse(params: {
  c: Context
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  response: ChatCompletionResponse
}): Promise<Response> {
  const {
    c,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    response,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  let httpStatus = 200
  const usage: NormalizedUsage = normalizeChatCompletionsUsage(response.usage)
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const finishedAtMs = Date.now()

  try {
    logger.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
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

async function streamChatCompletionsAndLog(params: {
  stream: StreamSseStream
  response: ChatCompletionsStream
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

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  try {
    for await (const rawChunk of response) {
      const chunk = rawChunk as SSEMessage

      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - request.startedAtMs
      }

      const usage = await extractUsageFromChunk(chunk)
      if (usage) {
        lastUsage = usage
      }

      logger.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk)
    }
  } catch (error) {
    const details = extractErrorDetails(error)
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    logger.warn("Streaming error:", error)
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

async function extractUsageFromChunk(
  chunk: SSEMessage,
): Promise<NormalizedUsage | undefined> {
  const data = typeof chunk.data === "string" ? chunk.data : await chunk.data

  if (!data || data === "[DONE]") {
    return undefined
  }

  try {
    const parsed = JSON.parse(data) as ChatCompletionChunk
    if (!parsed.usage) return undefined
    return normalizeChatCompletionsUsage(parsed.usage)
  } catch {
    return undefined
  }
}

async function handleNonStreamingRequest(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ChatCompletionsPayload
  selection: AccountSelectionOk
  accountCtx: Parameters<typeof createChatCompletions>[1]
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    accountCtx,
    clientModel,
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
    const response = await createChatCompletions(payload, accountCtx, {
      upstreamRequestId: request.upstreamRequestId,
      sessionId: request.upstreamSessionId,
    })
    selection.confirmAffinity?.()
    finishedAtMs = Date.now()

    if (!isNonStreaming(response)) {
      logger.debug("Unexpected streaming response")
      // If upstream returns streaming unexpectedly, we just forward it.
      // Note: This will not have "true completion" accounting.
      return streamSSE(c, async (stream) => {
        for await (const chunk of response) {
          await stream.writeSSE(chunk as SSEMessage)
        }
      })
    }

    usage = normalizeChatCompletionsUsage(response.usage)

    logger.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
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

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
