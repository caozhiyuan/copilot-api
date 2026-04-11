import { Hono, type Context } from "hono"
import { randomUUID } from "node:crypto"

import { accountsManager } from "~/lib/accounts-manager"
import { getAliasTargetSet } from "~/lib/config"
import { forwardError } from "~/lib/error"
import {
  computeDiff,
  extractErrorDetails,
  shouldMarkAccountFailed,
  toAccountContext,
} from "~/lib/handler-utils"
import {
  getClientIpInfo,
  getRequestHistoryStore,
  normalizeEmbeddingsUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

const EMBEDDINGS_ENDPOINT = "/embeddings"

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
}

embeddingRoutes.post("/", async (c) => {
  try {
    const store = getRequestHistoryStore()

    const requestId = randomUUID()
    const startedAtMs = Date.now()

    const method = c.req.raw.method
    const path = new URL(c.req.url, "http://local").pathname

    const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
    const userAgent = c.req.header("user-agent") ?? undefined

    const ctx: RequestContext = {
      requestId,
      startedAtMs,
      method,
      path,
      clientIp,
      clientIpSource,
      userAgent,
    }

    const payload = await c.req.json<EmbeddingRequest>()
    const clientModel = payload.model

    const blockedTargets = getAliasTargetSet()
    if (blockedTargets.has(clientModel.toLowerCase())) {
      recordSelectionFailure(store, {
        ctx,
        clientModel,
        reason: "MODEL_NOT_SUPPORTED",
      })
      return selectionFailureResponse(c, clientModel, "MODEL_NOT_SUPPORTED")
    }

    const selection = await accountsManager.selectAccountForRequest([
      {
        modelId: clientModel,
        endpoint: EMBEDDINGS_ENDPOINT,
      },
    ])

    if (!selection.ok) {
      recordSelectionFailure(store, {
        ctx,
        clientModel,
        reason: selection.reason,
      })
      return selectionFailureResponse(c, clientModel, selection.reason)
    }

    const upstreamPayload = { ...payload, model: selection.selectedModel.id }

    return await runEmbeddingsWithAccount({
      c,
      store,
      ctx,
      payload: upstreamPayload,
      clientModel,
      selection,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

function recordSelectionFailure(
  store: ReturnType<typeof getRequestHistoryStore>,
  params: {
    ctx: RequestContext
    clientModel: string
    reason: AccountSelectionErr["reason"]
  },
): void {
  const { ctx, clientModel, reason } = params

  const finishedAtMs = Date.now()

  store.insert({
    requestId: ctx.requestId,
    startedAtMs: ctx.startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - ctx.startedAtMs,
    method: ctx.method,
    path: ctx.path,
    upstreamEndpoint: EMBEDDINGS_ENDPOINT,
    stream: false,
    clientModel,
    clientIp: ctx.clientIp,
    clientIpSource: ctx.clientIpSource,
    userAgent: ctx.userAgent,
    httpStatus: reason === "MODEL_NOT_SUPPORTED" ? 400 : 429,
    selectionFailureReason: reason,
  })
}

function selectionFailureResponse(
  c: Context,
  clientModel: string,
  reason: AccountSelectionErr["reason"],
) {
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

async function runEmbeddingsWithAccount({
  c,
  store,
  ctx,
  payload,
  clientModel,
  selection,
}: {
  c: Context
  store: ReturnType<typeof getRequestHistoryStore>
  ctx: RequestContext
  payload: EmbeddingRequest
  clientModel: string
  selection: AccountSelectionOk
}) {
  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  const premiumRemainingBefore = account.premiumRemaining
  const premiumUnlimitedBefore = account.unlimited

  let httpStatus = 200
  let usage: NormalizedUsage = {}
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  let finishedAtMs: number | undefined

  try {
    const accountCtx = toAccountContext(account)

    const response = await createEmbeddings(payload, accountCtx)

    usage = normalizeEmbeddingsUsage(response.usage)

    finishedAtMs = Date.now()
    return c.json(response)
  } catch (error) {
    finishedAtMs = Date.now()

    const details = extractErrorDetails(error)

    httpStatus = details.httpStatus
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const finishedAtMsFinal = finishedAtMs ?? Date.now()

    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

    store.insert({
      requestId: ctx.requestId,
      startedAtMs: ctx.startedAtMs,
      finishedAtMs: finishedAtMsFinal,
      durationMs: finishedAtMsFinal - ctx.startedAtMs,
      method: ctx.method,
      path: ctx.path,
      upstreamEndpoint: endpoint,
      stream: false,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      clientModel,
      upstreamModel: selectedModel.id,
      clientIp: ctx.clientIp,
      clientIpSource: ctx.clientIpSource,
      userAgent: ctx.userAgent,
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
