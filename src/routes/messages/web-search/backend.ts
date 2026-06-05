import consola from "consola"

import {
  getWebSearchBackendModel,
  isResponsesApiWebSearchEnabled,
} from "~/lib/config"
import { createResponses } from "~/services/copilot/create-responses"
import type {
  ResponseOutputMessage,
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"

export interface WebSearchSource {
  url: string
  title: string
  page_age?: string | null
}

export interface WebSearchResult {
  /** The grounded answer text produced by the GPT backend (with inline cites). */
  answerText: string
  /** Deduped sources extracted from url_citation annotations. */
  sources: Array<WebSearchSource>
  /** Search queries the backend actually ran. */
  queriesRun: Array<string>
  /** Present when the backend search failed; answerText/sources are empty. */
  error?: string
}

export interface WebSearchBackendOptions {
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
  userLocation?: Record<string, unknown>
  requestId: string
  sessionId?: string
}

interface UrlCitationAnnotation {
  type: "url_citation"
  url: string
  title?: string
  start_index?: number
  end_index?: number
}

const buildWebSearchTool = (
  options: WebSearchBackendOptions,
): Record<string, unknown> => {
  const tool: Record<string, unknown> = { type: "web_search" }
  const filters: Record<string, unknown> = {}
  if (options.allowedDomains?.length) {
    filters.allowed_domains = options.allowedDomains
  }
  if (options.blockedDomains?.length) {
    filters.blocked_domains = options.blockedDomains
  }
  if (Object.keys(filters).length > 0) {
    tool.filters = filters
  }
  if (options.userLocation) {
    tool.user_location = options.userLocation
  }
  return tool
}

const isMessageItem = (
  item: ResponsesResult["output"][number],
): item is ResponseOutputMessage => item.type === "message"

const extractFromResult = (
  result: ResponsesResult,
): Pick<WebSearchResult, "answerText" | "sources" | "queriesRun"> => {
  const textParts: Array<string> = []
  const sources: Array<WebSearchSource> = []
  const seenUrls = new Set<string>()
  const queriesRun: Array<string> = []

  for (const item of result.output) {
    if (isMessageItem(item)) {
      for (const block of item.content ?? []) {
        if ((block as { type?: string }).type !== "output_text") {
          continue
        }
        const textBlock = block as {
          text?: string
          annotations?: Array<unknown>
        }
        if (textBlock.text) textParts.push(textBlock.text)
        for (const annotation of textBlock.annotations ?? []) {
          const ann = annotation as UrlCitationAnnotation
          if (
            ann.type === "url_citation"
            && ann.url
            && !seenUrls.has(ann.url)
          ) {
            seenUrls.add(ann.url)
            sources.push({ url: ann.url, title: ann.title ?? ann.url })
          }
        }
      }
      continue
    }

    if ((item as { type?: string }).type === "web_search_call") {
      const action = (
        item as { action?: { query?: string; queries?: Array<string> } }
      ).action
      if (action?.queries?.length) queriesRun.push(...action.queries)
      else if (action?.query) queriesRun.push(action.query)
    }
  }

  const answerText =
    textParts.join("\n\n").trim() || (result.output_text ?? "").trim()
  return { answerText, sources, queriesRun }
}

/**
 * Runs a single web search query through Copilot's GPT /responses web_search
 * tool and returns a normalized result. Never throws — failures are returned
 * in the `error` field so the caller can surface a graceful tool_result.
 */
export const runCopilotWebSearch = async (
  query: string,
  options: WebSearchBackendOptions,
): Promise<WebSearchResult> => {
  if (!isResponsesApiWebSearchEnabled()) {
    return {
      answerText: "",
      sources: [],
      queriesRun: [],
      error: "web search backend disabled (useResponsesApiWebSearch=false)",
    }
  }

  const payload: ResponsesPayload = {
    model: getWebSearchBackendModel(),
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [buildWebSearchTool(options)],
    stream: false,
  }

  try {
    const result = (await createResponses(payload, {
      vision: false,
      initiator: "agent",
      transport: "http",
      requestId: options.requestId,
      sessionId: options.sessionId,
    })) as ResponsesResult

    const extracted = extractFromResult(result)
    if (!extracted.answerText && extracted.sources.length === 0) {
      return { ...extracted, error: "web search returned no results" }
    }
    return extracted
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    consola.warn(`web search backend failed: ${message}`)
    return { answerText: "", sources: [], queriesRun: [], error: message }
  }
}
