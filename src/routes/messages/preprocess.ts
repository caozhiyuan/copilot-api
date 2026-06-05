import type { Model } from "~/services/copilot/get-models"

import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
  compactAutoContinuePromptStarts,
  compactMessageSections,
  compactSummaryPromptStart,
  compactSystemPromptStarts,
  compactTextOnlyGuard,
  type CompactType,
} from "~/lib/compact"
import { getReasoningEffortForModel } from "~/lib/config"
import { normalizeSdkModelId } from "~/lib/models"

import type {
  AnthropicAssistantContentBlock,
  AnthropicCacheControl,
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicInputMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolResultContentBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from "./anthropic-types"

export const TOOL_REFERENCE_TURN_BOUNDARY = "Tool loaded."
const SYSTEM_REMINDER_START = "<system-reminder>"
const SYSTEM_REMINDER_END = "</system-reminder>"
const SUBAGENT_START_HOOK_ADDITIONAL_PREFIX = "SubagentStart hook additional"

const IDE_EXECUTE_CODE_TOOL = "mcp__ide__executeCode"
const IDE_GET_DIAGNOSTICS_TOOL = "mcp__ide__getDiagnostics"
const IDE_GET_DIAGNOSTICS_DESCRIPTION =
  "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace."
const PDF_FILE_READ_PREFIX = "PDF file read:"

type AnthropicAttachmentBlock = AnthropicImageBlock | AnthropicDocumentBlock
type AnthropicMessageContentBlock =
  | AnthropicUserContentBlock
  | AnthropicAssistantContentBlock

const createTextBlock = (text: string): AnthropicTextBlock => ({
  type: "text",
  text,
})

const appendTextSegment = (base: string, addition: string): string => {
  if (base.length === 0) {
    return addition
  }
  if (addition.length === 0) {
    return base
  }

  return `${base}\n\n${addition}`
}

const ensureSystemReminderText = (text: string): string => {
  if (text.startsWith(SYSTEM_REMINDER_START)) {
    return text
  }

  return `${SYSTEM_REMINDER_START}\n${text.trim()}\n${SYSTEM_REMINDER_END}`
}

const normalizeSystemStringForMerge = (
  text: string,
): string | Array<AnthropicTextBlock> => {
  if (!text.startsWith(SUBAGENT_START_HOOK_ADDITIONAL_PREFIX)) {
    return ensureSystemReminderText(text)
  }

  const lineBreakMatch = /\r?\n/.exec(text)
  if (!lineBreakMatch) {
    return [createTextBlock(ensureSystemReminderText(text))]
  }

  const firstLine = text.slice(0, lineBreakMatch.index)
  const rest = text.slice(lineBreakMatch.index + lineBreakMatch[0].length)
  return [
    createTextBlock(ensureSystemReminderText(firstLine)),
    ...(rest.length > 0 ?
      [createTextBlock(ensureSystemReminderText(rest))]
    : []),
  ]
}

const normalizeSystemContentForMerge = (
  content: string | Array<AnthropicTextBlock>,
): string | Array<AnthropicTextBlock> => {
  if (typeof content === "string") {
    return normalizeSystemStringForMerge(content)
  }

  return content.map((block) =>
    block.text.startsWith(SYSTEM_REMINDER_START) ?
      block
    : {
        ...block,
        text: ensureSystemReminderText(block.text),
      },
  )
}

const toSystemTextBlocks = (
  content: string | Array<AnthropicTextBlock>,
): Array<AnthropicTextBlock> => {
  return typeof content === "string" ? [createTextBlock(content)] : [...content]
}

const mergeSystemPromptContent = (
  current: string | Array<AnthropicTextBlock> | undefined,
  addition: string | Array<AnthropicTextBlock>,
): string | Array<AnthropicTextBlock> => {
  if (current === undefined) {
    return typeof addition === "string" ? addition : [...addition]
  }

  if (typeof current === "string" && typeof addition === "string") {
    return appendTextSegment(current, addition)
  }

  return [...toSystemTextBlocks(current), ...toSystemTextBlocks(addition)]
}

const prependSystemContentToUserMessage = (
  message: AnthropicUserMessage,
  addition: string | Array<AnthropicTextBlock>,
): void => {
  if (typeof message.content === "string" && typeof addition === "string") {
    message.content = appendTextSegment(addition, message.content)
    return
  }

  if (Array.isArray(message.content)) {
    const lastToolResultIndex = message.content.findLastIndex(
      (block) => block.type === "tool_result",
    )
    if (lastToolResultIndex >= 0) {
      message.content = [
        ...message.content.slice(0, lastToolResultIndex + 1),
        ...toSystemTextBlocks(addition),
        ...message.content.slice(lastToolResultIndex + 1),
      ]
      return
    }
  }

  message.content = [
    ...toSystemTextBlocks(addition),
    ...(typeof message.content === "string" ?
      [createTextBlock(message.content)]
    : message.content),
  ]
}

export const normalizeSystemMessages = (
  payload: AnthropicMessagesPayload,
): void => {
  if (!payload.messages.some((msg) => msg.role === "system")) {
    return
  }

  const normalizedMessages: Array<AnthropicMessage> = []
  let system = payload.system

  for (const message of payload.messages) {
    if (message.role === "system") {
      const normalizedContent = normalizeSystemContentForMerge(message.content)
      const previousMessage = normalizedMessages.at(-1)
      if (previousMessage?.role === "user") {
        prependSystemContentToUserMessage(previousMessage, normalizedContent)
      } else if (!previousMessage) {
        system = mergeSystemPromptContent(system, normalizedContent)
      }
      continue
    }

    normalizedMessages.push(message)
  }

  payload.messages = normalizedMessages
  payload.system = system
}

const isVersionAtLeast = (
  version: string,
  minimumMajor: number,
  minimumMinor: number,
): boolean => {
  const [majorPart, minorPart = "0"] = version.split(".")
  const major = Number.parseInt(majorPart, 10)
  const minor = Number.parseInt(minorPart, 10)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return false
  }

  return (
    major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)
  )
}

const shouldSummarizeThinkingDisplayForModel = (model: string): boolean => {
  const normalized = normalizeSdkModelId(model)
  return Boolean(normalized && isVersionAtLeast(normalized.version, 4, 7))
}

type IndexedAttachment = {
  attachment: AnthropicAttachmentBlock
  order: number
}

const getBlockCacheControl = (
  block: AnthropicMessageContentBlock | undefined,
): AnthropicCacheControl | undefined => {
  if (!block || block.type === "thinking") {
    return undefined
  }

  const cacheControl = block.cache_control
  if (!cacheControl || typeof cacheControl !== "object") {
    return
  }

  return cacheControl
}

export const getLastMessageContentCacheControl = (
  lastMessage: AnthropicInputMessage | undefined,
): AnthropicCacheControl | undefined => {
  if (!lastMessage || !Array.isArray(lastMessage.content)) {
    return undefined
  }

  const cacheControl = getBlockCacheControl(lastMessage.content.at(-1))
  return cacheControl ? { ...cacheControl } : undefined
}

// Apply the original last message tail's cache_control to the rewritten tail. If
// the original tail was not marked, fall back to a default ephemeral marker.
export const applyLastMessageCacheControl = (
  anthropicPayload: AnthropicMessagesPayload,
  lastMessageCacheControl: AnthropicCacheControl | undefined,
): void => {
  const cacheControl = lastMessageCacheControl ?? {
    type: "ephemeral",
  }

  const lastMessage = anthropicPayload.messages.at(-1)
  if (!lastMessage || !Array.isArray(lastMessage.content)) {
    return
  }

  const lastBlock = lastMessage.content.at(-1)
  if (!lastBlock || lastBlock.type === "thinking" || lastBlock.cache_control) {
    return
  }

  lastBlock.cache_control = { ...cacheControl }
}

const getCompactCandidateText = (message: AnthropicInputMessage): string => {
  if (message.role !== "user") {
    return ""
  }

  if (typeof message.content === "string") {
    return message.content
  }

  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) =>
      block.text.startsWith("<system-reminder>") ? "" : block.text,
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const isCompactMessage = (lastMessage: AnthropicInputMessage): boolean => {
  const text = getCompactCandidateText(lastMessage)
  if (!text) {
    return false
  }

  return (
    text.includes(compactTextOnlyGuard)
    && text.includes(compactSummaryPromptStart)
    && compactMessageSections.some((section) => text.includes(section))
  )
}

const isCompactAutoContinueMessage = (
  lastMessage: AnthropicInputMessage,
): boolean => {
  const text = getCompactCandidateText(lastMessage)
  return (
    Boolean(text)
    && compactAutoContinuePromptStarts.some((promptStart) =>
      text.startsWith(promptStart),
    )
  )
}

export const getCompactType = (
  anthropicPayload: AnthropicMessagesPayload,
): CompactType => {
  const lastMessage = anthropicPayload.messages.at(-1)
  if (lastMessage && isCompactMessage(lastMessage)) {
    return COMPACT_REQUEST
  }

  if (lastMessage && isCompactAutoContinueMessage(lastMessage)) {
    return COMPACT_AUTO_CONTINUE
  }

  const system = anthropicPayload.system
  if (typeof system === "string") {
    const hasCompactSystemPrompt = compactSystemPromptStarts.some(
      (promptStart) => system.startsWith(promptStart),
    )
    return hasCompactSystemPrompt ? COMPACT_REQUEST : 0
  }
  if (!Array.isArray(system)) return 0

  const hasCompactSystemPrompt = system.some(
    (msg) =>
      typeof msg.text === "string"
      && compactSystemPromptStarts.some((promptStart) =>
        msg.text.startsWith(promptStart),
      ),
  )
  if (hasCompactSystemPrompt) {
    return COMPACT_REQUEST
  }

  return 0
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return {
    ...tr,
    content: [...tr.content, stripContentBlockCacheControl(textBlock)],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return {
    ...tr,
    content: [...tr.content, ...textBlocks.map(stripContentBlockCacheControl)],
  }
}

const mergeContentWithAttachments = (
  tr: AnthropicToolResultBlock,
  attachments: Array<AnthropicAttachmentBlock>,
): AnthropicToolResultBlock => {
  const cleanAttachments = attachments.map(stripContentBlockCacheControl)

  if (typeof tr.content === "string") {
    return {
      ...tr,
      content: [{ type: "text", text: tr.content }, ...cleanAttachments],
    }
  }

  return {
    ...tr,
    content: [...tr.content, ...cleanAttachments],
  }
}

const stripContentBlockCacheControl = <
  T extends AnthropicToolResultContentBlock,
>(
  block: T,
): T => {
  if (!Object.hasOwn(block, "cache_control")) {
    return block
  }

  const copy = { ...block }
  delete copy.cache_control
  return copy
}

const isAttachmentBlock = (
  block: AnthropicUserContentBlock,
): block is AnthropicAttachmentBlock => {
  return block.type === "image" || block.type === "document"
}

const getMergeableToolResultIndices = (
  toolResults: Array<AnthropicToolResultBlock>,
): Array<number> => {
  return toolResults.flatMap((block, index) =>
    block.is_error || hasToolRef(block) ? [] : [index],
  )
}

const mergeAttachmentsIntoToolResults = (
  toolResults: Array<AnthropicToolResultBlock>,
  attachmentsByToolResultIndex: Map<number, Array<IndexedAttachment>>,
): Array<AnthropicToolResultBlock> => {
  if (attachmentsByToolResultIndex.size === 0) {
    return toolResults
  }

  return toolResults.map((block, index) => {
    const matchedAttachments = attachmentsByToolResultIndex.get(index)
    if (!matchedAttachments) {
      return block
    }

    const orderedAttachments = [...matchedAttachments]
      .sort((left, right) => left.order - right.order)
      .map(({ attachment }) => attachment)

    return mergeContentWithAttachments(block, orderedAttachments)
  })
}

const assignAttachmentsToToolResults = (
  target: Map<number, Array<IndexedAttachment>>,
  attachments: Array<IndexedAttachment>,
  options: {
    toolResultIndices: Array<number>
    fallbackToolResultIndices?: Array<number>
  },
): void => {
  const { toolResultIndices } = options
  const fallbackToolResultIndices =
    options.fallbackToolResultIndices ?? toolResultIndices

  if (attachments.length === 0) {
    return
  }

  if (
    toolResultIndices.length > 0
    && toolResultIndices.length === attachments.length
  ) {
    for (const [index, toolResultIndex] of toolResultIndices.entries()) {
      const currentAttachments = target.get(toolResultIndex)
      if (currentAttachments) {
        currentAttachments.push(attachments[index])
        continue
      }

      target.set(toolResultIndex, [attachments[index]])
    }
    return
  }

  const lastToolResultIndex = fallbackToolResultIndices.at(-1)
  if (lastToolResultIndex === undefined) {
    return
  }

  const currentAttachments = target.get(lastToolResultIndex)
  if (currentAttachments) {
    currentAttachments.push(...attachments)
    return
  }

  target.set(lastToolResultIndex, [...attachments])
}

const startsWithPdfFileRead = (
  toolResult: AnthropicToolResultBlock,
): boolean => {
  if (typeof toolResult.content === "string") {
    return toolResult.content.startsWith(PDF_FILE_READ_PREFIX)
  }

  if (toolResult.content.some((block) => block.type === "document")) {
    return false
  }

  if (toolResult.content.length === 0) {
    return false
  }

  const firstBlock = toolResult.content[0]
  if (firstBlock.type !== "text") {
    return false
  }

  return firstBlock.text.startsWith(PDF_FILE_READ_PREFIX)
}

const collectMergeableUserContent = (
  content: Array<AnthropicUserContentBlock>,
): {
  toolResults: Array<AnthropicToolResultBlock>
  textBlocks: Array<AnthropicTextBlock>
  attachments: Array<IndexedAttachment>
} | null => {
  const toolResults: Array<AnthropicToolResultBlock> = []
  const textBlocks: Array<AnthropicTextBlock> = []
  const attachments: Array<IndexedAttachment> = []

  for (const [order, block] of content.entries()) {
    if (block.type === "tool_result") {
      toolResults.push(block)
      continue
    }
    if (block.type === "text") {
      textBlocks.push(block)
      continue
    }
    if (isAttachmentBlock(block)) {
      attachments.push({ attachment: block, order })
      continue
    }

    return null
  }

  return {
    toolResults,
    textBlocks,
    attachments,
  }
}

const mergeAttachmentsForToolResults = (
  toolResults: Array<AnthropicToolResultBlock>,
  attachments: Array<IndexedAttachment>,
): Array<AnthropicToolResultBlock> => {
  if (attachments.length === 0) {
    return toolResults
  }

  const documentBlocks = attachments.filter(
    ({ attachment }) => attachment.type === "document",
  )
  const mergeableToolResultIndices = getMergeableToolResultIndices(toolResults)
  const pdfReadToolResultIndices = mergeableToolResultIndices.filter((index) =>
    startsWithPdfFileRead(toolResults[index]),
  )

  const attachmentsByToolResultIndex = new Map<
    number,
    Array<IndexedAttachment>
  >()
  let remainingAttachments = attachments
  let countMatchToolResultIndices = mergeableToolResultIndices

  // Match PDF read tool results and documents in order first, then leave any
  // unmatched documents to the generic fallback path below.
  if (documentBlocks.length > 0 && pdfReadToolResultIndices.length > 0) {
    const matchedDocumentCount = Math.min(
      pdfReadToolResultIndices.length,
      documentBlocks.length,
    )
    const matchedDocuments = documentBlocks.slice(0, matchedDocumentCount)
    const matchedDocumentOrders = new Set(
      matchedDocuments.map(({ order }) => order),
    )
    const matchedPdfToolResultIndices = pdfReadToolResultIndices.slice(
      0,
      matchedDocumentCount,
    )
    const matchedPdfToolResultIndexSet = new Set(matchedPdfToolResultIndices)

    assignAttachmentsToToolResults(
      attachmentsByToolResultIndex,
      matchedDocuments,
      {
        toolResultIndices: matchedPdfToolResultIndices,
      },
    )
    countMatchToolResultIndices = mergeableToolResultIndices.filter(
      (index) => !matchedPdfToolResultIndexSet.has(index),
    )
    remainingAttachments = attachments.filter(
      ({ attachment, order }) =>
        attachment.type !== "document" || !matchedDocumentOrders.has(order),
    )
  }

  // Everything else keeps the existing count-match / last-tool-result fallback.
  assignAttachmentsToToolResults(
    attachmentsByToolResultIndex,
    remainingAttachments,
    {
      toolResultIndices: countMatchToolResultIndices,
      fallbackToolResultIndices: mergeableToolResultIndices,
    },
  )

  return mergeAttachmentsIntoToolResults(
    toolResults,
    attachmentsByToolResultIndex,
  )
}

const mergeUserMessageContent = (
  content: Array<AnthropicUserContentBlock>,
): Array<AnthropicUserContentBlock> | null => {
  const mergeableContent = collectMergeableUserContent(content)
  if (!mergeableContent) {
    return null
  }

  const { toolResults, textBlocks, attachments } = mergeableContent
  if (
    toolResults.length === 0
    || (textBlocks.length === 0 && attachments.length === 0)
  ) {
    return null
  }

  const mergedToolResults =
    textBlocks.length === 0 ?
      toolResults
    : mergeToolResult(toolResults, textBlocks)

  return mergeAttachmentsForToolResults(mergedToolResults, attachments)
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}

export const stripToolReferenceTurnBoundary = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const hasToolReference = msg.content.some(
      (block) => block.type === "tool_result" && hasToolRef(block),
    )
    if (!hasToolReference) continue

    msg.content = msg.content.filter(
      (block) =>
        block.type !== "text"
        || block.text.trim() !== TOOL_REFERENCE_TURN_BOUNDARY,
    )
  }
}

export const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    skipLastMessage?: boolean
  },
): void => {
  const lastMessageIndex = anthropicPayload.messages.length - 1

  for (const [index, msg] of anthropicPayload.messages.entries()) {
    if (options?.skipLastMessage && index === lastMessageIndex) continue

    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const mergedContent = mergeUserMessageContent(msg.content)
    if (mergedContent) {
      msg.content = mergedContent
    }
  }
}

// align with vscode copilot claude agent tools
export const sanitizeIdeTools = (payload: AnthropicMessagesPayload): void => {
  if (!payload.tools || payload.tools.length === 0) {
    return
  }

  payload.tools = payload.tools.flatMap((tool) => {
    if (tool.name === IDE_EXECUTE_CODE_TOOL && !tool.defer_loading) {
      return []
    }

    if (tool.name === IDE_GET_DIAGNOSTICS_TOOL) {
      return [
        {
          ...tool,
          description: IDE_GET_DIAGNOSTICS_DESCRIPTION,
        },
      ]
    }

    return [tool]
  })
}

const hasToolRef = (block: AnthropicToolResultBlock) => {
  return (
    Array.isArray(block.content)
    && block.content.some((c) => c.type === "tool_reference")
  )
}

// Strip cache_control from system content blocks as the
// Copilot Messages API does not support them (rejects extra fields like scope).
// commit by nicktogo
const stripCacheControl = (payload: AnthropicMessagesPayload): void => {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      const cacheControl = block.cache_control
      if (cacheControl && typeof cacheControl === "object") {
        const { scope, ...rest } = cacheControl
        block.cache_control = rest
      }
    }
  }
}

// Port top-level cache_control onto the last cacheable block as a lossless
// polyfill, then drop the top-level field.
const applyTopLevelCacheControl = (payload: AnthropicMessagesPayload): void => {
  const topLevel = payload.cache_control
  if (!topLevel || typeof topLevel !== "object") {
    if (topLevel !== undefined) {
      delete payload.cache_control
    }
    return
  }

  delete payload.cache_control

  for (let m = payload.messages.length - 1; m >= 0; m--) {
    const message = payload.messages[m]

    if (typeof message.content === "string") {
      message.content = [
        {
          type: "text",
          text: message.content,
          cache_control: { ...topLevel },
        },
      ]
      return
    }

    if (!Array.isArray(message.content)) continue

    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b]
      if (
        block.type !== "text"
        && block.type !== "image"
        && block.type !== "tool_use"
        && block.type !== "tool_result"
      ) {
        continue
      }
      if (!block.cache_control) {
        block.cache_control = { ...topLevel }
      }
      return
    }
  }
}

// Strip per-tool eager_input_streaming.
const stripToolEagerInputStreaming = (
  payload: AnthropicMessagesPayload,
): void => {
  if (!payload.tools || payload.tools.length === 0) return

  for (const tool of payload.tools) {
    const extended = tool as typeof tool & { eager_input_streaming?: unknown }
    if ("eager_input_streaming" in extended) {
      delete extended.eager_input_streaming
    }
  }
}

// Pre-request processing: filter thinking blocks for Claude models so only
// valid thinking blocks are sent to the Copilot Messages API.
const filterAssistantThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): void => {
  for (const msg of payload.messages) {
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
}

export const prepareMessagesApiPayload = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  stripCacheControl(payload)
  applyTopLevelCacheControl(payload)
  stripToolEagerInputStreaming(payload)
  filterAssistantThinkingBlocks(payload)

  const hasThinking = Boolean(payload.thinking)

  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking#extended-thinking-with-tool-use
  // Using tool_choice: {"type": "any"} or tool_choice: {"type": "tool", "name": "..."} will result in an error because these options force tool use, which is incompatible with extended thinking.
  const toolChoice = payload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"

  if (selectedModel?.capabilities.supports.adaptive_thinking && !disableThink) {
    payload.thinking = {
      type: "adaptive",
    }
    // align with vscode copilot
    if (!hasThinking) {
      payload.thinking.display = "summarized"
    }
    if (shouldSummarizeThinkingDisplayForModel(payload.model)) {
      payload.thinking.display = "summarized"
    }
    let effort = getReasoningEffortForModel(payload.model)
    if (effort === "none" || effort === "minimal") {
      effort = "low"
    }
    const reasoningEffort = selectedModel.capabilities.supports.reasoning_effort
    if (reasoningEffort && !reasoningEffort.includes(effort)) {
      effort = reasoningEffort.at(-1) as "low" | "medium" | "high"
    }
    payload.output_config = {
      effort: effort,
    }
  }
}
