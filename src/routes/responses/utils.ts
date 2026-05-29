import type {
  ResponseContextManagementCompactionItem,
  ResponseInputItem,
  ResponsesPayload,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  isResponsesApiContextManagementModel as isConfiguredResponsesApiContextManagementModel,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"

export const RESPONSES_ENDPOINT = "/responses"
export const RESPONSES_WS_ENDPOINT = "ws:/responses"

export const responsesUtilsDependencies = {
  isResponsesApiContextManagementModel:
    isConfiguredResponsesApiContextManagementModel,
  isResponsesApiWebSocketEnabled: isConfiguredResponsesApiWebSocketEnabled,
}

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  return { vision, initiator }
}

export const getResponsesTransportForModel = (
  selectedModel:
    | {
        supported_endpoints?: Array<string>
      }
    | undefined,
  options: {
    compactType?: CompactType
  } = {},
): ResponsesTransport | null => {
  const supportedEndpoints = selectedModel?.supported_endpoints ?? []
  const useWebSocket =
    responsesUtilsDependencies.isResponsesApiWebSocketEnabled()

  if (
    options.compactType !== COMPACT_REQUEST
    && useWebSocket
    && supportedEndpoints.includes(RESPONSES_WS_ENDPOINT)
  ) {
    return "websocket"
  }

  if (supportedEndpoints.includes(RESPONSES_ENDPOINT)) {
    return "http"
  }

  return null
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  // Refactor `isAgentCall` logic to check only the last message in the history rather than any message. This prevents valid user messages from being incorrectly flagged as agent calls due to previous assistant history, ensuring proper credit consumption for multi-turn conversations.
  const lastItem = getPayloadItems(payload).at(-1)
  if (!lastItem) {
    return false
  }
  if (!("role" in lastItem) || !lastItem.role) {
    return true
  }
  const role =
    typeof lastItem.role === "string" ? lastItem.role.toLowerCase() : ""
  return role === "assistant"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

const DATA_URL_PREFIX = "data:"
const BASE64_MARKER = ";base64,"
const IMAGE_MEDIA_TYPE_PATTERN = /^image\/[a-zA-Z0-9.+-]+$/
// Static 96x32 PNG reading "Image too large / Redacted".
const REDACTED_IMAGE_PLACEHOLDER_DATA_URL =
  "data:image/png;base64,"
  + [
    "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAMAAADaHo1mAAADAFBMVEX///8fKTfR1dsAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAACae8QWAAAAvElEQVR42u1WixKAIAhj/f9Hdz2BXJiVed3pVSYtpgwsGSo3GaRq6wSd4F8EyIJx",
    "ydSUAMB8il51sHT2fiVQu8czguQwXWAyFvswIJhmoS9gmzYlcFiHj1aAgzcJVgCyguYhAhNZmMhYQZs1EJnnIAqKiuHjSrZT",
    "ucSQ4s8JkKDDIYr3IuR8vEWgqroKP9b1bYKk2wfgeVmqATQLXdXamsXdEKkz3QXEEeTTuWWImMhW6qci94/+hwSVf99HqVoD",
    "OAuj2SEAAAAASUVORK5CYII=",
  ].join("")

export const sanitizeOversizedInputImages = (
  payload: ResponsesPayload,
  maxPromptImageSize?: number,
): number => {
  const limit =
    typeof maxPromptImageSize === "number" && maxPromptImageSize > 0 ?
      maxPromptImageSize
    : undefined

  if (!payload.input) {
    return 0
  }

  let count = 0
  for (const image of collectInputImageDataUrls(payload.input)) {
    if (limit !== undefined && image.decodedBytes > limit) {
      replaceInputImageWithPlaceholder(image)
      count += 1
    }
  }

  return count
}

export const sanitizeAllInputImages = (payload: ResponsesPayload): number => {
  if (!payload.input) {
    return 0
  }

  let count = 0
  for (const image of collectInputImageDataUrls(payload.input)) {
    replaceInputImageWithPlaceholder(image)
    count += 1
  }
  return count
}

interface InputImageDataUrl {
  decodedBytes: number
  mediaType: string
  record: Record<string, unknown>
}

const collectInputImageDataUrls = (
  value: unknown,
  images: Array<InputImageDataUrl> = [],
): Array<InputImageDataUrl> => {
  if (!value) {
    return images
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInputImageDataUrls(entry, images)
    }
    return images
  }

  if (typeof value !== "object") {
    return images
  }

  const record = value as Record<string, unknown>
  const image = getInputImageDataUrl(record)
  if (image) {
    images.push(image)
    return images
  }

  for (const key of Object.keys(record)) {
    collectInputImageDataUrls(record[key], images)
  }
  return images
}

const getInputImageDataUrl = (
  record: Record<string, unknown>,
): InputImageDataUrl | null => {
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined
  if (type !== "input_image" || typeof record.image_url !== "string") {
    return null
  }

  const imageUrl = record.image_url
  const base64MarkerIndex = imageUrl.indexOf(BASE64_MARKER)
  if (
    !imageUrl.startsWith(DATA_URL_PREFIX)
    || base64MarkerIndex <= DATA_URL_PREFIX.length
  ) {
    return null
  }

  const mediaType = imageUrl.slice(DATA_URL_PREFIX.length, base64MarkerIndex)
  if (!IMAGE_MEDIA_TYPE_PATTERN.test(mediaType)) {
    return null
  }

  const decodedBytes = getBase64DecodedByteLength(
    imageUrl,
    base64MarkerIndex + BASE64_MARKER.length,
  )

  return {
    decodedBytes,
    mediaType,
    record,
  }
}

const getBase64DecodedByteLength = (
  value: string,
  base64Start: number,
): number => {
  const base64Length = value.length - base64Start
  const padding =
    value.endsWith("==") ? 2
    : value.endsWith("=") ? 1
    : 0

  return Math.max(0, Math.floor((base64Length * 3) / 4) - padding)
}

const replaceInputImageWithPlaceholder = (image: InputImageDataUrl): void => {
  image.record.type = "input_image"
  image.record.image_url = REDACTED_IMAGE_PLACEHOLDER_DATA_URL
  image.record.detail = "low"
  delete image.record.text
  delete image.record.file_id
}

export const resolveResponsesCompactThreshold = (
  maxPromptTokens?: number,
): number => {
  if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
    return Math.floor(maxPromptTokens * 0.9)
  }

  return 50000
}

const createCompactionContextManagement = (
  compactThreshold: number,
): Array<ResponseContextManagementCompactionItem> => [
  {
    type: "compaction",
    compact_threshold: compactThreshold,
  },
]

export const applyResponsesApiContextManagement = (
  payload: ResponsesPayload,
  maxPromptTokens?: number,
): void => {
  if (payload.context_management !== undefined) {
    return
  }

  if (
    !responsesUtilsDependencies.isResponsesApiContextManagementModel(
      payload.model,
    )
  ) {
    return
  }

  payload.context_management = createCompactionContextManagement(
    resolveResponsesCompactThreshold(maxPromptTokens),
  )
}

export const compactInputByLatestCompaction = (
  payload: ResponsesPayload,
): void => {
  if (!Array.isArray(payload.input) || payload.input.length === 0) {
    return
  }

  const latestCompactionMessageIndex = getLatestCompactionMessageIndex(
    payload.input,
  )

  if (latestCompactionMessageIndex === undefined) {
    return
  }

  payload.input = payload.input.slice(latestCompactionMessageIndex)
}

const getLatestCompactionMessageIndex = (
  input: Array<ResponseInputItem>,
): number | undefined => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isCompactionInputItem(input[index])) {
      return index
    }
  }

  return undefined
}

const isCompactionInputItem = (value: ResponseInputItem): boolean => {
  return (
    "type" in value
    && typeof value.type === "string"
    && value.type === "compaction"
  )
}

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}
