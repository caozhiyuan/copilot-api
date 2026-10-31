import type { ResolvedProviderConfig } from "~/lib/config"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { ImageJsonMetadataReader } from "~/lib/image-json-metadata"
import { requestContext } from "~/lib/request-context"
import {
  ImageModelReader,
  JSON_CHUNK_BYTES,
  StreamingJsonReader,
} from "~/lib/streaming-json"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

import { createTokenUsageRecorder, type UsageTokens } from "./index"
import { xaiUsdTicksToCost } from "./pricing"
import { normalizeToken, type ImageTokenDetails } from "./store"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      normalizeToken(value)
    : undefined
}

function tokenDetails(value: unknown): ImageTokenDetails | undefined {
  if (!isRecord(value)) return undefined
  return {
    image_tokens: token(value.image_tokens),
    text_tokens: token(value.text_tokens),
  }
}

export function normalizeImagesUsage(
  usage: unknown,
  provider: string,
): UsageTokens {
  if (!isRecord(usage)) return {}
  const inputDetails = tokenDetails(usage.input_tokens_details)
  const outputDetails = tokenDetails(usage.output_tokens_details)
  return {
    cost:
      provider.toLowerCase() === "xai" ?
        xaiUsdTicksToCost(usage.cost_in_usd_ticks)
      : undefined,
    input_tokens:
      token(usage.input_tokens)
      ?? (inputDetails?.image_tokens ?? 0) + (inputDetails?.text_tokens ?? 0),
    input_tokens_details: inputDetails,
    output_tokens:
      token(usage.output_tokens)
      ?? (outputDetails?.image_tokens ?? 0) + (outputDetails?.text_tokens ?? 0),
    output_tokens_details: outputDetails,
    total_tokens: token(usage.total_tokens),
  }
}

/** Bounded compatibility reader; forwarding routes prepare a single, unteed body. */
export async function readImageRequestModel(
  request: Request,
  knownModel?: string,
  defaultModel?: string,
): Promise<string> {
  if (knownModel !== undefined) return knownModel
  if (request.headers.get("content-type")?.includes("multipart/form-data"))
    return "unknown"
  const reader = (
    request.clone().body as ReadableStream<Uint8Array> | null
  )?.getReader()
  if (!reader) return "unknown"
  const parser = new StreamingJsonReader()
  const model = new ImageModelReader()
  let length = 0
  try {
    while (length < JSON_CHUNK_BYTES) {
      const { done, value } = await reader.read()
      if (done) {
        model.read(parser.read())
        break
      }
      const bytes = value.subarray(0, JSON_CHUNK_BYTES - length)
      length += bytes.byteLength
      model.read(parser.read(bytes))
      if (model.complete || model.invalidModel || model.model !== undefined)
        break
    }
    if (!model.object || model.invalidModel) return "unknown"
    return (
      model.model ?? (model.complete ? (defaultModel ?? "unknown") : "unknown")
    )
  } catch {
    return "unknown"
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Observes bytes as the client reads them; image data is never buffered here. */
export function observeImagesResponse(
  response: Response,
  options: {
    model: string
    operation: "generations" | "edits"
    providerConfig: ResolvedProviderConfig
    onMetadata: (metadata: Record<string, unknown>) => void
  },
): Response {
  if (!response.body) return createProviderProxyResponse(response)
  const context = requestContext.getStore()
  const provider = options.providerConfig
  const recordUsage = createTokenUsageRecorder({
    source: provider.name === GITHUB_COPILOT_PROVIDER ? "copilot" : "provider",
    endpoint:
      options.operation === "edits" ? "images_edits" : "images_generations",
    model: options.model,
    pricing: provider.models?.[options.model]?.pricing,
    pricingCurrency: provider.pricingCurrency,
    providerName: provider.name,
  })
  let usage: UsageTokens = {}
  let finished = false
  const decoder = new TextDecoder()
  const metadataReader = new ImageJsonMetadataReader((metadata) => {
    if (context) requestContext.run(context, () => options.onMetadata(metadata))
    else options.onMetadata(metadata)
    if (response.ok) {
      if (isRecord(metadata.usage)) {
        usage = {
          ...usage,
          ...normalizeImagesUsage(metadata.usage, provider.name),
        }
      }
      if (
        provider.name === GITHUB_COPILOT_PROVIDER
        && isRecord(metadata.copilot_usage)
      ) {
        const totalNanoAiu = token(metadata.copilot_usage.total_nano_aiu)
        if (totalNanoAiu !== undefined) usage.total_nano_aiu = totalNanoAiu
      }
    }
  })
  const finish = () => {
    if (finished) return
    finished = true
    if (context) requestContext.run(context, () => recordUsage(usage))
    else recordUsage(usage)
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          metadataReader.write(decoder.decode())
          finish()
          reader.releaseLock()
          controller.close()
        } else {
          metadataReader.write(decoder.decode(next.value, { stream: true }))
          controller.enqueue(next.value)
        }
      } catch (error) {
        finish()
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish()
      await reader.cancel(reason)
      reader.releaseLock()
    },
  })
  return createProviderProxyResponse(response, body)
}
