import type { Model } from "~/services/copilot/get-models"

import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
  compactAutoContinuePromptStarts,
  compactMessageSections,
  compactSummaryPromptStart,
  compactSystemPromptStart,
  compactTextOnlyGuard,
  type CompactType,
} from "~/lib/compact"
import { getReasoningEffortForModel } from "~/lib/config"

import type {
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "./anthropic-types"

export const TOOL_REFERENCE_TURN_BOUNDARY = "Tool loaded."

const IDE_EXECUTE_CODE_TOOL = "mcp__ide__executeCode"
const IDE_GET_DIAGNOSTICS_TOOL = "mcp__ide__getDiagnostics"
const IDE_GET_DIAGNOSTICS_DESCRIPTION =
  "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace."
const PDF_FILE_READ_PREFIX = "PDF file read:"

type AnthropicAttachmentBlock = AnthropicImageBlock | AnthropicDocumentBlock
type IndexedAttachment = {
  attachment: AnthropicAttachmentBlock
  order: number
}

const getCompactCandidateText = (message: AnthropicMessage): string => {
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

const isCompactMessage = (lastMessage: AnthropicMessage): boolean => {
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
  lastMessage: AnthropicMessage,
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
    return system.startsWith(compactSystemPromptStart) ? COMPACT_REQUEST : 0
  }
  if (!Array.isArray(system)) return 0

  const hasCompactSystemPrompt = system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
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
    content: [...tr.content, textBlock],
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
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeContentWithAttachments = (
  tr: AnthropicToolResultBlock,
  attachments: Array<AnthropicAttachmentBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return {
      ...tr,
      content: [{ type: "text", text: tr.content }, ...attachments],
    }
  }

  return {
    ...tr,
    content: [...tr.content, ...attachments],
  }
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
      const systemBlock = block as AnthropicTextBlock & {
        cache_control?: Record<string, unknown>
      }
      const cacheControl = systemBlock.cache_control
      if (cacheControl && typeof cacheControl === "object") {
        const { scope, ...rest } = cacheControl
        systemBlock.cache_control = rest
      }
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
    if (payload.model === "claude-opus-4.7") {
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
