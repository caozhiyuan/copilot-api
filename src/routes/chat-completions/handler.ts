import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"
import { randomUUID } from "node:crypto"

import {
  accountsManager,
  type AccountSelectionReason,
} from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import { getAliasTargetSet } from "~/lib/config"
import {
  computeDiff,
  extractErrorObservability,
  getUserVisibleErrorMessage,
  shouldMarkAccountFailed,
  toAccountContext,
} from "~/lib/handler-utils"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
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
  resolveAffinityKey,
  type AffinityKeySource,
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

function buildChatCompletionCandidates(clientModel: string) {
  return [
    {
      modelId: clientModel,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
    },
  ]
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)
  const store = getRequestHistoryStore()
  const request = buildRequestContext(c)
  const payload = await c.req.json<ChatCompletionsPayload>()
  const clientModel = payload.model
  const streamRequested = Boolean(payload.stream)
  const initiator = getChatInitiator(payload.messages)
  const normalizedPromptCacheKey = applyChatRequestMetadata(
    request,
    payload,
    initiator,
  )
  if (getAliasTargetSet().has(clientModel.toLowerCase())) {
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
  debugJsonTail(logger, "Request payload:", { value: payload, tailLength: 400 })
  const upstreamRequestId = generateRequestIdFromPayload(
    payload,
    normalizedPromptCacheKey,
  )
  const headerSessionId = c.req.header("x-session-id") ?? null
  const affinityKey = resolveAffinityKey({
    metadataSessionId: normalizedPromptCacheKey,
    headerSessionId,
    upstreamRequestId,
  })
  request.affinityKeyUsed = affinityKey.affinityKeyUsed
  request.affinityKeySource = affinityKey.affinityKeySource
  const selection = await accountsManager.selectAccountForRequest(
    buildChatCompletionCandidates(clientModel),
    {
      requestId: affinityKey.requestId,
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
  request.selectionReason = selection.selectionReason

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

  affinityKeyUsed?: string
  affinityKeySource?: AffinityKeySource
  selectionReason?: AccountSelectionReason
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

function applyChatRequestMetadata(
  request: RequestContext,
  payload: ChatCompletionsPayload,
  initiator: "agent" | "user",
): string | undefined {
  const userId = payload.user ?? undefined
  const { safetyIdentifier, sessionId: promptCacheKey } =
    parseUserIdMetadata(userId)
  const normalizedPromptCacheKey = promptCacheKey ?? undefined

  request.userId = userId
  request.safetyIdentifier = safetyIdentifier ?? undefined
  request.promptCacheKey = normalizedPromptCacheKey
  request.initiator = initiator

  return normalizedPromptCacheKey
}

async function writeChatCompletionsStreamError(
  stream: StreamSseStream,
  message: string,
): Promise<void> {
  try {
    await stream.writeSSE({
      data: JSON.stringify({
        error: {
          message,
          type: "error",
        },
      }),
    })
    await stream.writeSSE({ data: "[DONE]" })
  } catch (streamError) {
    logger.warn(
      "Failed to write chat completions stream error event:",
      streamError,
    )
  }
}

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
    affinityKeyUsed: request.affinityKeyUsed,
    affinityKeySource: request.affinityKeySource,
    selectionReason: request.selectionReason,
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

  debugJson(logger, "Set max_tokens to:", updated.max_tokens)

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
  const details = await extractErrorObservability(error)

  if (shouldMarkAccountFailed(details)) {
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
    upstreamErrorMessageRaw: details.upstreamErrorMessageRaw,
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
  let upstreamErrorMessageRaw: string | undefined

  const finishedAtMs = Date.now()

  try {
    debugJson(logger, "Non-streaming response:", response)
    return c.json(response)
  } catch (error) {
    const details = await extractErrorObservability(error)
    httpStatus = details.httpStatus
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

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
      upstreamErrorMessageRaw,
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
  let upstreamErrorMessageRaw: string | undefined

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

      debugJson(logger, "Streaming chunk:", chunk)
      await stream.writeSSE(chunk)
    }
  } catch (error) {
    const details = await extractErrorObservability(error)
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    logger.warn("Streaming error:", error)

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
    }

    await writeChatCompletionsStreamError(
      stream,
      getUserVisibleErrorMessage(details),
    )
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
      upstreamErrorMessageRaw,
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
  let upstreamErrorMessageRaw: string | undefined
  let finishedAtMs: number | undefined

  try {
    const response = (await createChatCompletions(payload, accountCtx, {
      upstreamRequestId: request.upstreamRequestId,
      sessionId: request.upstreamSessionId,
    })) as ChatCompletionResponse
    selection.confirmAffinity?.()
    finishedAtMs = Date.now()
    usage = normalizeChatCompletionsUsage(response.usage)

    debugJson(logger, "Non-streaming response:", response)
    return c.json(response)
  } catch (error) {
    finishedAtMs = Date.now()

    const details = await extractErrorObservability(error)
    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    if (shouldMarkAccountFailed(details)) {
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
      upstreamErrorMessageRaw,
    })
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
