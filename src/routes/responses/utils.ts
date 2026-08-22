import type {
  ResponseContextManagementCompactionItem,
  ResponseCustomToolCallOutputItem,
  ResponseFunctionCallOutputItem,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponsesTransport,
} from "~/lib/types/responses"

import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  getModelResponsesApiCompactThreshold as getConfiguredModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages as isConfiguredContextManagementEnabledForMessages,
  isContextManagementEnabledForResponses as isConfiguredContextManagementEnabledForResponses,
  isGpt56OrAbove,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"
import {
  resolveSupportedReasoningEffort,
  type ResponsesReasoningEffort,
} from "~/lib/reasoning-effort"

export const RESPONSES_ENDPOINT = "/responses"
export const RESPONSES_WS_ENDPOINT = "ws:/responses"
export const DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO = 0.85
export type ResponsesApiContextManagementSource = "messages" | "responses"

export const normalizeResponsesReasoningEffort = (
  payload: ResponsesPayload,
  supportedEfforts: Array<string> | undefined,
): { from: string; to: ResponsesReasoningEffort } | undefined => {
  if (!payload.reasoning || typeof payload.reasoning.effort !== "string") {
    return undefined
  }

  const resolvedEffort = resolveSupportedReasoningEffort(
    payload.reasoning.effort,
    supportedEfforts,
  )
  if (!resolvedEffort || resolvedEffort === payload.reasoning.effort) {
    return undefined
  }

  const requestedEffort = payload.reasoning.effort
  payload.reasoning.effort = resolvedEffort
  return { from: requestedEffort, to: resolvedEffort }
}

export const responsesUtilsDependencies = {
  getModelResponsesApiCompactThreshold:
    getConfiguredModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages:
    isConfiguredContextManagementEnabledForMessages,
  isContextManagementEnabledForResponses:
    isConfiguredContextManagementEnabledForResponses,
  isGpt56OrAbove,
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

const COPILOT_UNSUPPORTED_INPUT_ITEM_FIELDS = [
  "internal_chat_message_metadata_passthrough",
] as const

export const sanitizeUnsupportedInputFields = (
  payload: ResponsesPayload,
): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  let removedFieldCount = 0
  for (const item of payload.input) {
    if (typeof item !== "object" || item === null) {
      continue
    }

    const record = item as Record<string, unknown>
    for (const field of COPILOT_UNSUPPORTED_INPUT_ITEM_FIELDS) {
      if (!Object.hasOwn(record, field)) {
        continue
      }

      delete record[field]
      removedFieldCount += 1
    }
  }

  return removedFieldCount
}

export const sanitizeOversizedInputImages = (
  payload: ResponsesPayload,
  maxPromptImageSize?: number,
): number => {
  const limit =
    typeof maxPromptImageSize === "number" && maxPromptImageSize > 0 ?
      maxPromptImageSize
    : undefined

  if (limit === undefined || !Array.isArray(payload.input)) {
    return 0
  }

  return sanitizeInputImages(
    payload.input,
    (image) => image.decodedBytes > limit,
  )
}

export const sanitizeAllInputImages = (payload: ResponsesPayload): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  return sanitizeInputImages(payload.input, () => true)
}

export const normalizeInputImageDetails = (
  payload: ResponsesPayload,
): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  let normalizedCount = 0
  for (const image of collectInputImages(payload.input)) {
    if (
      image.detail === undefined
      || VALID_INPUT_IMAGE_DETAILS.has(image.detail)
    ) {
      continue
    }

    image.detail = "auto"
    normalizedCount += 1
  }

  return normalizedCount
}

interface InputImageDataUrl {
  decodedBytes: number
  record: ResponseInputImage
}

const sanitizeInputImages = (
  input: Array<ResponseInputItem>,
  shouldReplace: (image: InputImageDataUrl) => boolean,
): number => {
  let count = 0
  for (const record of collectInputImages(input)) {
    const image = getInputImageDataUrl(record)
    if (!image) {
      continue
    }

    if (!shouldReplace(image)) {
      continue
    }

    replaceInputImageWithPlaceholder(image)
    count += 1
  }

  return count
}

const collectInputImages = (
  input: Array<ResponseInputItem>,
  images: Array<ResponseInputImage> = [],
): Array<ResponseInputImage> => {
  for (const item of input) {
    if (isResponseInputMessage(item)) {
      collectContentImages(item.content, images)
    } else if (isResponseFunctionCallOutputItem(item)) {
      collectContentImages(item.output, images)
    }
  }

  return images
}

const collectContentImages = (
  content: string | Array<ResponseInputContent> | undefined,
  images: Array<ResponseInputImage>,
): void => {
  if (!Array.isArray(content)) {
    return
  }

  for (const block of content) {
    if (isResponseInputImage(block)) {
      images.push(block)
    }
  }
}

const getInputImageDataUrl = (
  image: ResponseInputImage,
): InputImageDataUrl | null => {
  if (typeof image.image_url !== "string") {
    return null
  }

  const imageUrl = image.image_url
  if (!imageUrl.startsWith(DATA_URL_PREFIX)) {
    return null
  }

  const decodedBytes = estimateDataUrlByteLength(imageUrl)

  return {
    decodedBytes,
    record: image,
  }
}

const estimateDataUrlByteLength = (value: string): number => {
  return Math.max(0, Math.floor((value.length * 3) / 4))
}

const replaceInputImageWithPlaceholder = (image: InputImageDataUrl): void => {
  image.record.type = "input_image"
  image.record.image_url = REDACTED_IMAGE_PLACEHOLDER_DATA_URL
  image.record.detail = "low"
  delete image.record.file_id
}

const VALID_INPUT_IMAGE_DETAILS: ReadonlySet<
  NonNullable<ResponseInputImage["detail"]>
> = new Set(["auto", "high", "low"])

const isResponseInputMessage = (
  item: ResponseInputItem,
): item is ResponseInputMessage => {
  return (
    typeof item === "object"
    && item !== null
    && "role" in item
    && typeof item.role === "string"
  )
}

const isResponseFunctionCallOutputItem = (
  item: ResponseInputItem,
): item is
  | ResponseCustomToolCallOutputItem
  | ResponseFunctionCallOutputItem => {
  return (
    typeof item === "object"
    && item !== null
    && "type" in item
    && (item.type === "custom_tool_call_output"
      || item.type === "function_call_output")
  )
}

const isResponseInputImage = (
  content: ResponseInputContent,
): content is ResponseInputImage => {
  return (
    typeof content === "object"
    && content !== null
    && "type" in content
    && content.type === "input_image"
  )
}

export const resolveResponsesCompactThreshold = (
  maxPromptTokens?: number,
  compactThresholdRatio = DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
): number => {
  if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
    return Math.floor(maxPromptTokens * compactThresholdRatio)
  }

  return 200_000 * compactThresholdRatio
}

const getModelResponsesApiCompactThreshold = (
  model: string,
): number | undefined => {
  const threshold =
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold(model)

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
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
  maxPromptTokens: number | undefined,
  options: {
    compactThresholdRatio?: number
    source: ResponsesApiContextManagementSource
  },
): boolean => {
  if (!payload.model.startsWith("gpt")) {
    return false
  }

  if (responsesUtilsDependencies.isGpt56OrAbove(payload.model)) {
    return false
  }

  if (hasTerminalCompactionTrigger(payload)) {
    return isContextManagementEnabledForSource(options.source)
  }

  if (payload.context_management !== undefined) {
    return true
  }

  if (!isContextManagementEnabledForSource(options.source)) {
    return false
  }

  const modelCompactThreshold = getModelResponsesApiCompactThreshold(
    payload.model,
  )
  payload.context_management = createCompactionContextManagement(
    modelCompactThreshold
      ?? resolveResponsesCompactThreshold(
        maxPromptTokens,
        options.compactThresholdRatio
          ?? DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
      ),
  )
  return true
}

const isContextManagementEnabledForSource = (
  source: ResponsesApiContextManagementSource,
): boolean => {
  if (source === "messages") {
    return responsesUtilsDependencies.isContextManagementEnabledForMessages()
  }

  return responsesUtilsDependencies.isContextManagementEnabledForResponses()
}

export const hasTerminalCompactionTrigger = (
  payload: ResponsesPayload,
): boolean => {
  const { input } = payload
  if (!Array.isArray(input) || input.length === 0) {
    return false
  }

  return isResponseInputItemType(input.at(-1), "compaction_trigger")
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
  return isResponseInputItemType(value, "compaction")
}

const isResponseInputItemType = (value: unknown, type: string): boolean => {
  return (
    typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === type
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
