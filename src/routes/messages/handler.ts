/* eslint-disable max-lines */
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import {
  getSmallModel,
  isMessageStartInputTokensFallbackEnabled,
  shouldCompactUseSmallModel,
} from "~/lib/config"
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
  normalizeChatCompletionsUsage,
  normalizeMessagesUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
import { state } from "~/lib/state"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  parseUserId,
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  createChatCompletions,
  getChatInitiator,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createMessages,
  getMessagesInitiator,
} from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import {
  estimateInputTokens,
  handleSelectionFailure,
  isWarmupProbeRequest,
  maybeBlockOriginalModelName,
  mergeToolResultForClaude,
} from "./utils"

const logger = createHandlerLogger("messages-handler")

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

type AccountSelection = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type AccountSelectionOk = Extract<AccountSelection, { ok: true }>

type InstrumentationContext = {
  store: ReturnType<typeof getRequestHistoryStore>
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

  clientModel: string

  account: AccountRuntime
  reservation: AccountSelectionOk["reservation"]
  upstreamModel: string
  upstreamEndpoint: string
  costUnits: number

  premiumRemainingBefore?: number
  premiumUnlimitedBefore?: boolean
}

// eslint-disable-next-line max-lines-per-function
export async function handleCompletion(c: Context) {
  await checkRateLimit(state)
  const store = getRequestHistoryStore()
  const requestId = randomUUID()
  const startedAtMs = Date.now()
  const method = c.req.raw.method
  const path = new URL(c.req.url, "http://local").pathname
  const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
  const userAgent = c.req.header("user-agent") ?? undefined
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))
  const anthropicBeta = c.req.header("anthropic-beta")
  const isCompact = isCompactRequest(anthropicPayload)

  // Fix warmup probe: force small model for Claude Code warmup requests (CLAUDE_CODE_SUBAGENT_MODEL also works).
  if (anthropicBeta && isWarmupProbeRequest(anthropicPayload)) {
    anthropicPayload.model = getSmallModel()
  }

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
    if (shouldCompactUseSmallModel()) {
      anthropicPayload.model = getSmallModel()
    }
  } else {
    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    mergeToolResultForClaude(anthropicPayload)
  }

  const clientModel = anthropicPayload.model
  const streamRequested = Boolean(anthropicPayload.stream)
  const rawUserId = anthropicPayload.metadata?.user_id
  const userId = typeof rawUserId === "string" ? rawUserId : undefined
  const { safetyIdentifier, promptCacheKey } = parseUserId(userId)
  const normalizedSafetyIdentifier = safetyIdentifier ?? undefined
  const normalizedPromptCacheKey = promptCacheKey ?? undefined
  const blockedResponse = maybeBlockOriginalModelName({
    c,
    store,
    requestId,
    startedAtMs,
    method,
    path,
    streamRequested,
    clientModel,
    clientIp,
    clientIpSource,
    userAgent,
    userId,
    safetyIdentifier: normalizedSafetyIdentifier,
    promptCacheKey: normalizedPromptCacheKey,
  })
  if (blockedResponse) return blockedResponse

  const openAIPayload = translateToOpenAI(anthropicPayload)
  const fallbackInitiator = getChatInitiator(openAIPayload.messages)

  const selection = await accountsManager.selectAccountForRequest([
    {
      modelId: clientModel,
      endpoint: MESSAGES_ENDPOINT,
    },
    {
      modelId: clientModel,
      endpoint: RESPONSES_ENDPOINT,
    },
    {
      modelId: openAIPayload.model,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
    },
  ])
  if (!selection.ok) {
    return handleSelectionFailure({
      c,
      store,
      requestId,
      startedAtMs,
      method,
      path,
      streamRequested,
      clientModel,
      clientIp,
      clientIpSource,
      userAgent,
      userId,
      safetyIdentifier: normalizedSafetyIdentifier,
      promptCacheKey: normalizedPromptCacheKey,
      initiator: fallbackInitiator,
      selection,
    })
  }
  const { account, reservation, selectedModel, endpoint, costUnits } = selection
  openAIPayload.model = selectedModel.id
  const premiumRemainingBefore = account.premiumRemaining
  const premiumUnlimitedBefore = account.unlimited
  if (state.manualApprove) {
    await awaitApproval()
  }
  const instr: InstrumentationContext = {
    store,
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
    userId,
    safetyIdentifier: normalizedSafetyIdentifier,
    promptCacheKey: normalizedPromptCacheKey,
    clientModel,
    account,
    reservation,
    upstreamEndpoint: endpoint,
    upstreamModel: selectedModel.id,
    costUnits,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  }
  if (endpoint === MESSAGES_ENDPOINT) {
    return await handleWithMessagesApi({
      c,
      anthropicPayload,
      anthropicBetaHeader: anthropicBeta ?? undefined,
      instr,
    })
  }
  if (endpoint === RESPONSES_ENDPOINT) {
    return await handleWithResponsesApi({
      c,
      anthropicPayload,
      openAIPayload,
      selectedModel,
      instr,
    })
  }

  return await handleWithChatCompletions({
    c,
    openAIPayload,
    selectedModel,
    instr,
  })
}

const handleWithChatCompletions = async (params: {
  c: Context
  openAIPayload: ChatCompletionsPayload
  selectedModel: Model
  instr: InstrumentationContext
}): Promise<Response> => {
  const { c, openAIPayload, selectedModel, instr } = params
  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const ctx = toAccountContext(instr.account)
  const initiator = getChatInitiator(openAIPayload.messages)
  const upstreamRequestId = randomUUID()

  instr.initiator = initiator
  instr.upstreamRequestId = upstreamRequestId

  let response: ChatCompletionsResult

  try {
    response = await createChatCompletions(openAIPayload, ctx, {
      upstreamRequestId,
    })
  } catch (error) {
    return await handleChatCompletionsCreateError({
      error,
      instr,
      stream: Boolean(openAIPayload.stream),
    })
  }

  if (isNonStreaming(response)) {
    return handleChatCompletionsNonStreaming({
      c,
      response,
      instr,
    })
  }

  logger.debug("Streaming response from Copilot")

  const fallbackEnabled = isMessageStartInputTokensFallbackEnabled()

  const estimatedInputTokens =
    fallbackEnabled ?
      await estimateInputTokens(openAIPayload, selectedModel, logger)
    : undefined

  const historicalUsage =
    fallbackEnabled && instr.promptCacheKey && instr.safetyIdentifier ?
      instr.store.getLastCompletedUsageBySession({
        promptCacheKey: instr.promptCacheKey,
        safetyIdentifier: instr.safetyIdentifier,
        clientModel: instr.clientModel,
      })
    : null

  return streamSSE(c, (stream) =>
    streamChatCompletionsAndLog({
      stream,
      response,
      instr,
      estimatedInputTokens,
      historicalUsage: historicalUsage ?? undefined,
    }),
  )
}

const handleWithResponsesApi = async (params: {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  openAIPayload: ChatCompletionsPayload
  selectedModel: Model
  instr: InstrumentationContext
}): Promise<Response> => {
  const { c, anthropicPayload, openAIPayload, selectedModel, instr } = params
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    selectedModel.id,
  )
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const ctx = toAccountContext(instr.account)
  const upstreamRequestId = randomUUID()

  instr.initiator = initiator
  instr.upstreamRequestId = upstreamRequestId

  let response: Awaited<ReturnType<typeof createResponses>>

  try {
    response = await createResponses(
      responsesPayload,
      {
        vision,
        initiator,
        upstreamRequestId,
      },
      ctx,
    )
  } catch (error) {
    return await handleResponsesCreateError({
      error,
      instr,
      stream: Boolean(responsesPayload.stream),
    })
  }

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")

    const fallbackEnabled = isMessageStartInputTokensFallbackEnabled()

    const estimatedInputTokens =
      fallbackEnabled ?
        await estimateInputTokens(openAIPayload, selectedModel, logger)
      : undefined

    const historicalUsage =
      fallbackEnabled && instr.promptCacheKey && instr.safetyIdentifier ?
        instr.store.getLastCompletedUsageBySession({
          promptCacheKey: instr.promptCacheKey,
          safetyIdentifier: instr.safetyIdentifier,
          clientModel: instr.clientModel,
        })
      : null

    return streamSSE(c, (stream) =>
      streamResponsesAndLog({
        stream,
        response,
        instr,
        estimatedInputTokens,
        historicalUsage: historicalUsage ?? undefined,
      }),
    )
  }

  return handleResponsesNonStreaming({
    c,
    result: response as ResponsesResult,
    instr,
  })
}

type Store = ReturnType<typeof getRequestHistoryStore>

type RequestLogInsert = Parameters<Store["insert"]>[0]

type StreamSseStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

type ChatCompletionsResult = Awaited<ReturnType<typeof createChatCompletions>>

type ChatCompletionsStream = Exclude<
  ChatCompletionsResult,
  ChatCompletionResponse
>

type MessagesResult = Awaited<ReturnType<typeof createMessages>>

function insertRequestLog(
  instr: InstrumentationContext,
  record: Omit<
    RequestLogInsert,
    | "requestId"
    | "startedAtMs"
    | "method"
    | "path"
    | "clientIp"
    | "clientIpSource"
    | "userAgent"
    | "clientModel"
    | "upstreamEndpoint"
    | "accountId"
    | "accountType"
    | "costUnits"
    | "upstreamModel"
    | "premiumRemainingBefore"
    | "premiumUnlimitedBefore"
  >,
): void {
  const {
    store,
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
    clientModel,
    account,
    upstreamEndpoint,
    upstreamModel,
    costUnits,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  } = instr

  store.insert({
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
    userId: instr.userId,
    safetyIdentifier: instr.safetyIdentifier,
    promptCacheKey: instr.promptCacheKey,
    initiator: instr.initiator,
    upstreamRequestId: instr.upstreamRequestId,
    clientModel,
    upstreamEndpoint,
    accountId: account.id,
    accountType: account.accountType,
    costUnits,
    upstreamModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    ...record,
  })
}

async function finalizeQuotaAndGetPremiumSnapshot(
  instr: InstrumentationContext,
): Promise<{
  premiumRemainingAfter: number | undefined
  premiumUnlimitedAfter: boolean | undefined
  premiumRemainingDiff: number | undefined
}> {
  await accountsManager.finalizeQuota(instr.account, instr.reservation)

  const premiumRemainingAfter = instr.account.premiumRemaining
  const premiumUnlimitedAfter = instr.account.unlimited

  return {
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff: computeDiff(
      instr.premiumRemainingBefore,
      premiumRemainingAfter,
    ),
  }
}

async function handleChatCompletionsCreateError(params: {
  error: unknown
  instr: InstrumentationContext
  stream: boolean
}): Promise<never> {
  const { error, instr, stream } = params

  const finishedAtMs = Date.now()
  const details = extractErrorDetails(error)

  if (details.unauthorized) {
    accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
  }

  const { premiumRemainingAfter, premiumUnlimitedAfter, premiumRemainingDiff } =
    await finalizeQuotaAndGetPremiumSnapshot(instr)

  insertRequestLog(instr, {
    finishedAtMs,
    durationMs: finishedAtMs - instr.startedAtMs,
    stream,
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
  })

  throw error
}

async function handleChatCompletionsNonStreaming(params: {
  c: Context
  response: ChatCompletionResponse
  instr: InstrumentationContext
}): Promise<Response> {
  const { c, response, instr } = params

  let httpStatus = 200
  const usage: NormalizedUsage = normalizeChatCompletionsUsage(response.usage)

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const finishedAtMs = Date.now()

  try {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )

    const anthropicResponse = translateToAnthropic(response)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )

    return c.json(anthropicResponse)
  } catch (error) {
    const details = extractErrorDetails(error)

    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      stream: false,
      ...usage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
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
  instr: InstrumentationContext
  estimatedInputTokens?: number
  historicalUsage?: NormalizedUsage
}): Promise<void> {
  const { stream, response, instr, estimatedInputTokens, historicalUsage } =
    params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    thinkingBlockOpen: false,
    estimatedInputTokens,
    historicalInputTokens: historicalUsage?.tokensInput,
    historicalOutputTokens: historicalUsage?.tokensOutput,
    historicalCachedInputTokens: historicalUsage?.tokensCachedInput,
  }

  try {
    for await (const rawEvent of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - instr.startedAtMs
      }

      logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))

      const { data: rawData } = rawEvent as {
        data?: string | Promise<string>
      }
      const data = typeof rawData === "string" ? rawData : await rawData

      if (data === "[DONE]") {
        break
      }

      if (!data) {
        continue
      }

      const chunk = JSON.parse(data) as ChatCompletionChunk
      if (chunk.usage) {
        lastUsage = normalizeChatCompletionsUsage(chunk.usage)
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)
      for (const event of events) {
        logger.debug("Translated Anthropic event:", JSON.stringify(event))

        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  } catch (error) {
    const details = extractErrorDetails(error)

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    logger.warn("Streaming error:", error)

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }
  } finally {
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

async function handleResponsesCreateError(params: {
  error: unknown
  instr: InstrumentationContext
  stream: boolean
}): Promise<never> {
  const { error, instr, stream } = params

  const finishedAtMs = Date.now()
  const details = extractErrorDetails(error)

  if (details.unauthorized) {
    accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
  }

  const { premiumRemainingAfter, premiumUnlimitedAfter, premiumRemainingDiff } =
    await finalizeQuotaAndGetPremiumSnapshot(instr)

  insertRequestLog(instr, {
    finishedAtMs,
    durationMs: finishedAtMs - instr.startedAtMs,
    stream,
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
  })

  throw error
}

async function handleResponsesNonStreaming(params: {
  c: Context
  result: ResponsesResult
  instr: InstrumentationContext
}): Promise<Response> {
  const { c, result, instr } = params

  let httpStatus = 200
  let usage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const finishedAtMs = Date.now()

  try {
    usage = extractResponsesUsageFromResult(result)

    logger.debug(
      "Non-streaming Responses result:",
      JSON.stringify(result).slice(-400),
    )

    const anthropicResponse = translateResponsesResultToAnthropic(result)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )

    return c.json(anthropicResponse)
  } catch (error) {
    const details = extractErrorDetails(error)

    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      stream: false,
      ...usage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

async function ensureResponsesStreamCompleted(params: {
  stream: StreamSseStream
  streamState: ReturnType<typeof createResponsesStreamState>
  setStreamError: (name: string, message: string) => void
}): Promise<void> {
  const { stream, streamState, setStreamError } = params

  if (streamState.messageCompleted) {
    return
  }

  logger.warn("Responses stream ended without completion; sending error event")

  const msg = "Responses stream ended without completion"
  const errorEvent = buildErrorEvent(msg)

  setStreamError("StreamIncomplete", msg)

  await stream.writeSSE({
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  })
}

async function streamResponsesAndLog(params: {
  stream: StreamSseStream
  response: AsyncIterable<unknown>
  instr: InstrumentationContext
  estimatedInputTokens?: number
  historicalUsage?: NormalizedUsage
}): Promise<void> {
  const { stream, response, instr, estimatedInputTokens, historicalUsage } =
    params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const streamState = createResponsesStreamState()
  streamState.estimatedInputTokens = estimatedInputTokens
  streamState.historicalInputTokens = historicalUsage?.tokensInput
  streamState.historicalOutputTokens = historicalUsage?.tokensOutput
  streamState.historicalCachedInputTokens = historicalUsage?.tokensCachedInput

  try {
    for await (const chunk of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - instr.startedAtMs
      }

      const eventName = (chunk as { event?: string }).event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: "" })
        continue
      }

      const data = (chunk as { data?: string }).data
      if (!data) {
        continue
      }

      logger.debug("Responses raw stream event:", data)

      const parsed = JSON.parse(data) as ResponseStreamEvent
      const u = extractResponsesUsageFromStreamEvent(parsed)
      if (u.usageJson) {
        lastUsage = u
      }

      const events = translateResponsesStreamEvent(parsed, streamState)
      for (const event of events) {
        const eventData = JSON.stringify(event)
        logger.debug("Translated Anthropic event:", eventData)
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }

      if (streamState.messageCompleted) {
        logger.debug("Message completed, ending stream")
        break
      }
    }

    await ensureResponsesStreamCompleted({
      stream,
      streamState,
      setStreamError: (name, message) => {
        errorName = name
        errorMessage = message
      },
    })
  } catch (error) {
    const details = extractErrorDetails(error)

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    logger.warn("Streaming error:", error)

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }
  } finally {
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

async function handleMessagesCreateError(params: {
  error: unknown
  instr: InstrumentationContext
  stream: boolean
}): Promise<never> {
  const { error, instr, stream } = params

  const finishedAtMs = Date.now()
  const details = extractErrorDetails(error)

  if (details.unauthorized) {
    accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
  }

  const { premiumRemainingAfter, premiumUnlimitedAfter, premiumRemainingDiff } =
    await finalizeQuotaAndGetPremiumSnapshot(instr)

  insertRequestLog(instr, {
    finishedAtMs,
    durationMs: finishedAtMs - instr.startedAtMs,
    stream,
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
  })

  throw error
}

async function handleMessagesNonStreaming(params: {
  c: Context
  response: AnthropicResponse
  instr: InstrumentationContext
}): Promise<Response> {
  const { c, response, instr } = params

  let httpStatus = 200
  const usage = normalizeMessagesUsage(response.usage)

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const finishedAtMs = Date.now()

  try {
    logger.debug(
      "Non-streaming Messages result:",
      JSON.stringify(response).slice(-400),
    )
    return c.json(response)
  } catch (error) {
    const details = extractErrorDetails(error)

    httpStatus = details.httpStatus
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      stream: false,
      ...usage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

const parseMessagesStreamUsage = (data: string): NormalizedUsage | null => {
  if (!data) return null

  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (parsed.type !== "message_delta" || !parsed.usage) {
      return null
    }

    return normalizeMessagesUsage(parsed.usage)
  } catch (error) {
    logger.warn("Failed to parse messages stream event", error)
    return null
  }
}

async function streamMessagesAndLog(params: {
  stream: StreamSseStream
  response: AsyncIterable<unknown>
  instr: InstrumentationContext
}): Promise<void> {
  const { stream, response, instr } = params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  try {
    for await (const rawEvent of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - instr.startedAtMs
      }

      const eventNameRaw = (rawEvent as { event?: string }).event
      const eventName =
        typeof eventNameRaw === "string" && eventNameRaw.length > 0 ?
          eventNameRaw
        : "message"
      const data = (rawEvent as { data?: string }).data ?? ""
      logger.debug("Messages raw stream event:", data)

      const usage = parseMessagesStreamUsage(data)
      if (usage) {
        lastUsage = usage
      }

      await stream.writeSSE({
        event: eventName,
        data,
      })
    }
  } catch (error) {
    const details = extractErrorDetails(error)

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    logger.warn("Streaming error:", error)

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }
  } finally {
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
    })
  }
}

const handleWithMessagesApi = async (params: {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  anthropicBetaHeader?: string
  instr: InstrumentationContext
}): Promise<Response> => {
  const { c, anthropicPayload, anthropicBetaHeader, instr } = params

  // Pre-request processing: filter thinking blocks for Claude models so only
  // valid thinking blocks are sent to the Copilot Messages API.
  for (const msg of anthropicPayload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }

  const ctx = toAccountContext(instr.account)
  const upstreamRequestId = randomUUID()
  const initiator = getMessagesInitiator(anthropicPayload)

  instr.initiator = initiator
  instr.upstreamRequestId = upstreamRequestId

  let response: MessagesResult

  try {
    response = await createMessages(anthropicPayload, ctx, {
      anthropicBetaHeader,
      upstreamRequestId,
    })
  } catch (error) {
    return await handleMessagesCreateError({
      error,
      instr,
      stream: Boolean(anthropicPayload.stream),
    })
  }

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, (stream) =>
      streamMessagesAndLog({
        stream,
        response,
        instr,
      }),
    )
  }

  return handleMessagesNonStreaming({
    c,
    response,
    instr,
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}
