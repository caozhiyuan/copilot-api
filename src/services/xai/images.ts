const XAI_ASPECT_RATIOS = [
  { label: "1:1", width: 1, height: 1 },
  { label: "16:9", width: 16, height: 9 },
  { label: "9:16", width: 9, height: 16 },
  { label: "4:3", width: 4, height: 3 },
  { label: "3:4", width: 3, height: 4 },
  { label: "3:2", width: 3, height: 2 },
  { label: "2:3", width: 2, height: 3 },
  { label: "2:1", width: 2, height: 1 },
  { label: "1:2", width: 1, height: 2 },
  { label: "19.5:9", width: 19.5, height: 9 },
  { label: "9:19.5", width: 9, height: 19.5 },
  { label: "20:9", width: 20, height: 9 },
  { label: "9:20", width: 9, height: 20 },
] as const

const XAI_ASPECT_RATIO_LABELS = new Set<string>([
  ...XAI_ASPECT_RATIOS.map((ratio) => ratio.label),
  "auto",
])

const XAI_RESPONSE_FORMATS = new Set(["url", "b64_json"])
const XAI_RESOLUTIONS = new Set(["1k", "2k"])
const MAX_EDIT_IMAGES = 5
const MAX_IMAGE_COUNT = 10
const HIGH_RESOLUTION_EDGE = 1536

export class XaiImagesRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "XaiImagesRequestError"
  }
}

interface XaiImageReference {
  type: "image_url"
  url: string
}

type ParsedSize = { height: number; width: number } | "auto"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readPrompt(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new XaiImagesRequestError("prompt is required")
  }

  return value
}

function assertNotStreaming(value: unknown): void {
  if (value === true || value === "true") {
    throw new XaiImagesRequestError(
      "xAI image requests do not support streaming",
    )
  }
}

function readCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined

  const parsed =
    typeof value === "number" ? value
    : typeof value === "string" ? Number(value.trim())
    : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_IMAGE_COUNT) {
    throw new XaiImagesRequestError(
      `n must be an integer from 1 to ${MAX_IMAGE_COUNT}`,
    )
  }

  return parsed
}

function readQuality(value: unknown): "auto" | "low" | "medium" | undefined {
  if (typeof value !== "string") return undefined

  switch (value.trim().toLowerCase()) {
    case "low":
      return "low"
    case "medium":
    case "standard":
    case "high":
    case "hd":
      return "medium"
    case "auto":
      return "auto"
    default:
      return undefined
  }
}

function readChoice(
  value: unknown,
  allowed: ReadonlySet<string>,
  name: string,
  normalize: (value: string) => string = (item) => item,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") {
    throw new XaiImagesRequestError(`${name} is invalid`)
  }

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const normalized = normalize(trimmed)
  if (!allowed.has(normalized)) {
    throw new XaiImagesRequestError(
      `${name} must be one of ${Array.from(allowed).join(", ")}`,
    )
  }

  return normalized
}

function readAspectRatio(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new XaiImagesRequestError("aspect_ratio is invalid")
  }

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const normalized = trimmed.toLowerCase() === "auto" ? "auto" : trimmed
  if (!XAI_ASPECT_RATIO_LABELS.has(normalized)) {
    throw new XaiImagesRequestError(
      "aspect_ratio must be a supported xAI ratio such as 1:1, 16:9, 9:16, or auto",
    )
  }

  return normalized
}

function readSize(value: unknown): ParsedSize | undefined {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return undefined
  if (trimmed === "auto") return "auto"

  const match = /^(\d+)x(\d+)$/u.exec(trimmed)
  if (!match?.[1] || !match[2]) return undefined

  const width = Number(match[1])
  const height = Number(match[2])
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    return undefined
  }

  return { height, width }
}

function aspectRatioFromSize(size: ParsedSize | undefined): string | undefined {
  if (!size) return undefined
  if (size === "auto") return "auto"

  let best: string = XAI_ASPECT_RATIOS[0].label
  let bestDistance = Number.POSITIVE_INFINITY
  const ratio = Math.log(size.width / size.height)
  for (const candidate of XAI_ASPECT_RATIOS) {
    const distance = Math.abs(
      ratio - Math.log(candidate.width / candidate.height),
    )
    if (distance < bestDistance) {
      best = candidate.label
      bestDistance = distance
    }
  }

  return best
}

function resolutionFromSize(
  size: ParsedSize | undefined,
): "1k" | "2k" | undefined {
  if (!size || size === "auto") return undefined
  return Math.max(size.width, size.height) >= HIGH_RESOLUTION_EDGE ? "2k" : "1k"
}

function applyCommonImageFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  assertNotStreaming(source.stream)

  const count = readCount(source.n)
  const quality = readQuality(source.quality)
  const responseFormat = readChoice(
    source.response_format,
    XAI_RESPONSE_FORMATS,
    "response_format",
  )
  const aspectRatio =
    readAspectRatio(source.aspect_ratio)
    ?? aspectRatioFromSize(readSize(source.size))
  const resolution =
    readChoice(source.resolution, XAI_RESOLUTIONS, "resolution", (value) =>
      value.toLowerCase(),
    ) ?? resolutionFromSize(readSize(source.size))

  if (count !== undefined) target.n = count
  // Only Imagine 2.0 accepts quality; legacy models must omit the field.
  if (quality && target.model === "grok-imagine-image-2.0") {
    target.quality = quality
  }
  // OpenAI image clients decode b64_json. xAI omits that field unless asked.
  target.response_format = responseFormat ?? "b64_json"
  if (aspectRatio) target.aspect_ratio = aspectRatio
  if (resolution) target.resolution = resolution
}

function normalizeImageUrl(value: string): string {
  const trimmed = value.trim()
  if (
    /^https?:\/\//iu.test(trimmed)
    || /^data:image\/[a-z0-9.+-]+;base64,/iu.test(trimmed)
  ) {
    return trimmed
  }

  throw new XaiImagesRequestError(
    "image must be an http(s) URL or a base64 data URL",
  )
}

function base64ToDataUrl(value: string, mime: unknown): string {
  const compact = value.trim().replaceAll(/\s+/gu, "")
  if (compact.startsWith("data:image/")) return normalizeImageUrl(compact)
  if (!/^[a-z0-9+/]+={0,2}$/iu.test(compact)) {
    throw new XaiImagesRequestError("image b64_json is not valid base64")
  }

  const mediaType =
    typeof mime === "string" && mime.trim().toLowerCase().startsWith("image/") ?
      mime.trim().toLowerCase()
    : "image/png"
  return `data:${mediaType};base64,${compact}`
}

function readImageReference(value: unknown): XaiImageReference {
  if (typeof value === "string") {
    return { type: "image_url", url: normalizeImageUrl(value) }
  }
  if (!isRecord(value)) {
    throw new XaiImagesRequestError("image must be a URL or an image object")
  }
  if (typeof value.url === "string") {
    return { type: "image_url", url: normalizeImageUrl(value.url) }
  }
  if (typeof value.image_url === "string") {
    return { type: "image_url", url: normalizeImageUrl(value.image_url) }
  }
  if (typeof value.b64_json === "string") {
    return {
      type: "image_url",
      url: base64ToDataUrl(value.b64_json, value.mime_type ?? value.media_type),
    }
  }

  if (value.file_id !== undefined) {
    throw new XaiImagesRequestError(
      "file_id is not supported for xAI image edits; provide an image_url instead",
    )
  }
  throw new XaiImagesRequestError(
    "image must include a url, image_url, or b64_json",
  )
}

function collectJsonImages(payload: Record<string, unknown>): Array<unknown> {
  const values: Array<unknown> = []
  if (isUnknownArray(payload.image)) values.push(...payload.image)
  else if (payload.image !== undefined) values.push(payload.image)
  if (isUnknownArray(payload.images)) values.push(...payload.images)
  if (payload.image_url !== undefined) values.push(payload.image_url)
  return values
}

function isUnknownArray(value: unknown): value is Array<unknown> {
  return Array.isArray(value)
}

function buildEditPayload(
  model: string,
  prompt: string,
  images: Array<XaiImageReference>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  if (source.mask !== undefined) {
    throw new XaiImagesRequestError("xAI image edits do not support mask")
  }
  if (images.length === 0) {
    throw new XaiImagesRequestError("image is required")
  }
  if (images.length > MAX_EDIT_IMAGES) {
    throw new XaiImagesRequestError(
      `xAI image edits accept at most ${MAX_EDIT_IMAGES} images`,
    )
  }

  const payload: Record<string, unknown> = { model, prompt }
  applyCommonImageFields(payload, source)
  if (images.length === 1) payload.image = images[0]
  else payload.images = images
  return payload
}

/**
 * Translates an OpenAI image generation body into an xAI Imagine generation
 * request. The configured model replaces the client model.
 */
export function translateXaiImageGeneration(
  payload: unknown,
  model: string,
): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new XaiImagesRequestError(
      "Image generation body must be a JSON object",
    )
  }

  const translated: Record<string, unknown> = {
    model,
    prompt: readPrompt(payload.prompt),
  }
  applyCommonImageFields(translated, payload)
  return translated
}

/**
 * Translates an OpenAI JSON image edit body into an xAI Imagine edit request.
 */
export function translateXaiImageEditJson(
  payload: unknown,
  model: string,
): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new XaiImagesRequestError("Image edit body must be a JSON object")
  }

  return buildEditPayload(
    model,
    readPrompt(payload.prompt),
    collectJsonImages(payload).map((image) => readImageReference(image)),
    payload,
  )
}

const MAX_RESPONSE_IMAGE_BYTES = 32 * 1024 * 1024

function responseHasB64Json(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== ""
}

function imageCreatedTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value)
  }

  return Math.floor(Date.now() / 1000)
}

function trustedImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null

  try {
    const url = new URL(value.trim())
    // xAI's documented output CDN is imgen.x.ai. Never let an upstream
    // response turn this fallback into a request to an arbitrary host/port.
    if (
      url.protocol !== "https:"
      || url.hostname !== "imgen.x.ai"
      || url.port
      || url.username
      || url.password
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

async function readImageBytes(response: Response): Promise<Buffer | null> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_RESPONSE_IMAGE_BYTES
  ) {
    await response.body?.cancel().catch(() => {})
    return null
  }

  if (!response.body) return null

  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        complete = true
        return length > 0 ? Buffer.concat(chunks, length) : null
      }

      length += value.byteLength
      if (length > MAX_RESPONSE_IMAGE_BYTES) return null
      chunks.push(value)
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function imageDownloadErrorResponse(): Response {
  return Response.json(
    {
      error: {
        message: "Failed to retrieve xAI image output as b64_json",
        type: "upstream_error",
      },
    },
    { status: 502 },
  )
}

interface ImageResponseOptions {
  clientSignal?: AbortSignal
  onImageUrl?: (url: string) => void
  responseFormat?: "url" | "b64_json"
}

function imageOutputUrlForLog(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    url.username = ""
    url.password = ""
    for (const key of url.searchParams.keys()) {
      if (
        /token|secret|signature|credential|password|authorization|api[_-]?key|^key$|^sig$/iu.test(
          key,
        )
      ) {
        url.searchParams.set(key, "[REDACTED]")
      }
    }
    return url.toString()
  } catch {
    return null
  }
}

function rebuildJsonResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  if (!headers.get("content-type")) {
    headers.set("content-type", "application/json")
  }
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

/**
 * Adapts an xAI image body to the OpenAI Images response.
 * Generation returns created: null, and edits omit created. OpenAI clients
 * require a unix timestamp. When b64_json is requested, a URL-only result
 * is downloaded from the xAI CDN with redirects disabled and a byte limit.
 */
export async function ensureImageResponseB64Json(
  response: Response,
  fetchImage: (
    url: string,
    init: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
  {
    clientSignal,
    onImageUrl,
    responseFormat = "b64_json",
  }: ImageResponseOptions = {},
): Promise<Response> {
  if (!response.ok) return response

  clientSignal?.throwIfAborted()

  const body = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return rebuildJsonResponse(response, body)
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return rebuildJsonResponse(response, body)
  }

  let changed = false
  const data: Array<unknown> = []
  for (const item of payload.data) {
    if (isRecord(item) && onImageUrl) {
      const outputUrl = imageOutputUrlForLog(item.url)
      if (outputUrl) onImageUrl(outputUrl)
    }
    if (
      !isRecord(item)
      || responseFormat === "url"
      || responseHasB64Json(item.b64_json)
    ) {
      data.push(item)
      continue
    }

    const url = trustedImageUrl(item.url)
    if (!url) return imageDownloadErrorResponse()

    try {
      clientSignal?.throwIfAborted()
      const timeoutSignal = AbortSignal.timeout(60_000)
      const imageResponse = await fetchImage(url, {
        method: "GET",
        redirect: "error",
        signal:
          clientSignal ?
            AbortSignal.any([clientSignal, timeoutSignal])
          : timeoutSignal,
      })
      if (!imageResponse.ok) {
        await imageResponse.body?.cancel().catch(() => {})
        return imageDownloadErrorResponse()
      }
      const bytes = await readImageBytes(imageResponse)
      if (!bytes) return imageDownloadErrorResponse()
      data.push({
        ...item,
        b64_json: bytes.toString("base64"),
      })
      changed = true
    } catch {
      clientSignal?.throwIfAborted()
      return imageDownloadErrorResponse()
    }
  }

  const created = imageCreatedTimestamp(payload.created)
  if (!changed && payload.created === created) {
    return rebuildJsonResponse(response, body)
  }
  return rebuildJsonResponse(
    response,
    JSON.stringify({ ...payload, created, data }),
  )
}
