import { getApiKeyQuotaAdmission } from "~/lib/auth/api-key-quota-runtime"
import { HTTPError } from "~/lib/http/error"
import { requestContext } from "~/lib/http/request-context"
import { createHandlerLogger } from "~/lib/logger"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/providers/github-copilot-provider"
import type {
  ImageGenerationCall,
  ImageGenerationTool,
} from "~/lib/types/responses"
import { forwardCopilotImagesWithLogging } from "~/routes/images/forward-provider-images"
import { createResponsesHttpEventStream } from "~/services/responses-http"

const logger = createHandlerLogger("responses-image-tool")
const forwardedOptions = [
  "size",
  "quality",
  "background",
  "output_format",
  "output_compression",
  "moderation",
] as const
const supported = new Set<string>([
  ...forwardedOptions,
  "type",
  "model",
  "action",
  "input_image_mask",
  "input_fidelity",
  "partial_images",
])

interface ToolImageOptions {
  model: string
  prompt: string
  tool: ImageGenerationTool
  inputImages: Array<{ image_url: string } | { file_id: string }>
  id: string
  signal?: AbortSignal
  onPartialImage?: (index: number, base64: string) => void | Promise<void>
}

export const copilotToolImageDependencies = {
  forward: forwardCopilotImagesWithLogging,
  quota: getApiKeyQuotaAdmission,
}

function imageError(message: string, status = 502, type = "upstream_error") {
  return new HTTPError(
    message,
    Response.json({ error: { message, type } }, { status }),
  )
}

function invalid(message: string) {
  return imageError(message, 400, "invalid_request_error")
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function base64Image(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  )
    throw imageError("GitHub Copilot Images returned no valid base64 image")
  return value
}

async function readStream(
  response: Response,
  options: ToolImageOptions,
  editing: boolean,
) {
  let final: Record<string, unknown> | undefined
  const prefix = editing ? "image_edit" : "image_generation"
  for await (const event of createResponsesHttpEventStream(response)) {
    options.signal?.throwIfAborted()
    if (!event.data) continue
    if (event.data === "[DONE]") break
    const data = record(parseImageJson(event.data))
    const kind = data.type ?? event.event
    if (kind === "error" || data.error) {
      const message = record(data.error).message ?? data.message
      throw imageError(
        typeof message === "string" ? message : (
          "GitHub Copilot Images stream failed"
        ),
      )
    }
    if (kind === prefix + ".completed") {
      final = data
    } else if (kind === prefix + ".partial_image" && options.onPartialImage) {
      const index = data.partial_image_index
      if (
        typeof index !== "number"
        || !Number.isSafeInteger(index)
        || index < 0
      )
        throw imageError(
          "GitHub Copilot Images returned an invalid preview index",
        )
      await options.onPartialImage(
        index,
        base64Image(data.b64_json ?? data.partial_image_b64),
      )
    }
  }
  if (!final)
    throw imageError(
      "GitHub Copilot Images stream ended before the final image",
    )
  return final
}

function parseImageJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw imageError("GitHub Copilot Images returned invalid JSON")
  }
}

async function runToolImage(
  options: ToolImageOptions,
): Promise<ImageGenerationCall> {
  const { tool, prompt, id, inputImages, signal } = options
  signal?.throwIfAborted()
  const model = options.model.trim().replace(/^github-copilot\//u, "")
  if (!model || model.includes("/"))
    throw invalid("Expected a GitHub Copilot image model")
  if (!prompt.trim()) throw invalid("Image generation requires a prompt")
  for (const key of Object.keys(tool)) {
    if (!supported.has(key))
      throw invalid("Unsupported image_generation option: " + key)
  }
  const action = tool.action ?? "auto"
  if (action !== "auto" && action !== "generate" && action !== "edit")
    throw invalid("Invalid image_generation action")
  const editing = inputImages.length > 0 && action !== "generate"
  if (!editing && (action === "edit" || tool.input_image_mask != null))
    throw invalid("Image editing requires a source image")
  const partials = tool.partial_images ?? 0
  if (!Number.isInteger(partials) || partials < 0 || partials > 3)
    throw invalid("partial_images must be an integer from 0 to 3")
  const stream = Boolean(options.onPartialImage && partials > 0)
  const operation = editing ? "edits" : "generations"
  const payload: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    response_format: "b64_json",
    ...(stream && { stream: true, partial_images: partials }),
    ...(editing && { images: inputImages }),
    ...(editing
      && tool.input_fidelity != null && {
        input_fidelity: tool.input_fidelity,
      }),
    ...(editing
      && tool.input_image_mask != null && { mask: tool.input_image_mask }),
  }
  for (const key of forwardedOptions) {
    if (tool[key] != null) payload[key] = tool[key]
  }
  const key = requestContext.getStore()?.apiKey
  if (key?.quota) {
    const balance = await copilotToolImageDependencies.quota(key).catch(() => {
      throw imageError("API key quota unavailable", 503, "service_unavailable")
    })
    if (balance.remainingCostNanos === 0)
      throw imageError(
        "API key spending limit exhausted",
        429,
        "rate_limit_error",
      )
  }
  const request = new Request("http://localhost/v1/images/" + operation, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  })
  const response = await copilotToolImageDependencies.forward(
    request,
    operation,
    {
      logger,
      model,
      provider: GITHUB_COPILOT_PROVIDER,
    },
  )
  if (!response.ok) throw await upstreamError(response)
  const json =
    response.headers.get("content-type")?.includes("text/event-stream") ?
      await readStream(response, options, editing)
    : record(parseImageJson(await response.text()))
  const image =
    Array.isArray(json.data) ? { ...json, ...record(json.data[0]) } : json
  const metadata: Pick<ImageGenerationCall, "size" | "quality" | "background"> =
    {}
  for (const field of ["size", "quality", "background"] as const) {
    if (typeof image[field] === "string") metadata[field] = image[field]
  }
  signal?.throwIfAborted()
  const format = image.output_format ?? tool.output_format ?? "png"
  return {
    type: "image_generation_call",
    id,
    status: "completed",
    action: editing ? "edit" : "generate",
    result: base64Image(image.b64_json),
    revised_prompt:
      typeof image.revised_prompt === "string" ? image.revised_prompt : prompt,
    ...(typeof format === "string" && { output_format: format }),
    ...metadata,
  }
}

async function upstreamError(response: Response) {
  const body = await response.text()
  let message = "GitHub Copilot Images returned HTTP " + response.status
  try {
    const detail = record(record(JSON.parse(body)).error).message
    if (typeof detail === "string") message = detail
  } catch {
    // Keep the upstream body available to the route's error handler.
  }
  return new HTTPError(
    message,
    new Response(body, { status: response.status, headers: response.headers }),
  )
}

export function executeCopilotToolImage(
  options: ToolImageOptions,
): Promise<ImageGenerationCall> {
  const context = requestContext.getStore()
  // Charge the same key without replacing the outer chat model or plugin usage.
  return context ?
      requestContext.run(
        { ...context, pluginRequest: undefined, requestTiming: undefined },
        () => runToolImage(options),
      )
    : runToolImage(options)
}
