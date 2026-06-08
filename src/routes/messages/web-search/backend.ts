import type {
  ResponseOutputMessage,
  ResponsesResult,
} from "~/services/copilot/create-responses"

export interface WebSearchSource {
  url: string
  title: string
  page_age?: string | null
}

export interface WebSearchExtract {
  /** The grounded answer text produced by the GPT backend (with inline cites). */
  answerText: string
  /** Deduped sources extracted from url_citation annotations. */
  sources: Array<WebSearchSource>
  /** Search queries the backend actually ran. */
  queries: Array<string>
}

export interface WebSearchToolConfig {
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
  userLocation?: Record<string, unknown>
}

interface UrlCitationAnnotation {
  type: "url_citation"
  url: string
  title?: string
}

/** Builds the Responses API web_search tool object from the Anthropic config. */
export const buildResponsesWebSearchTool = (
  config: WebSearchToolConfig,
): Record<string, unknown> => {
  const tool: Record<string, unknown> = { type: "web_search" }
  const filters: Record<string, unknown> = {}
  if (config.allowedDomains?.length) {
    filters.allowed_domains = config.allowedDomains
  }
  if (config.blockedDomains?.length) {
    filters.blocked_domains = config.blockedDomains
  }
  if (Object.keys(filters).length > 0) tool.filters = filters
  if (config.userLocation) tool.user_location = config.userLocation
  return tool
}

const isMessageItem = (
  item: ResponsesResult["output"][number],
): item is ResponseOutputMessage => item.type === "message"

/**
 * Extracts the answer text, deduped sources, and run queries from a GPT
 * /responses web_search result.
 */
export const extractWebSearchResult = (
  result: ResponsesResult,
): WebSearchExtract => {
  const textParts: Array<string> = []
  const sources: Array<WebSearchSource> = []
  const seenUrls = new Set<string>()
  const queries: Array<string> = []

  for (const item of result.output) {
    if (isMessageItem(item)) {
      for (const block of item.content ?? []) {
        if ((block as { type?: string }).type !== "output_text") continue
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
      if (action?.queries?.length) queries.push(...action.queries)
      else if (action?.query) queries.push(action.query)
    }
  }

  const answerText =
    textParts.join("\n\n").trim() || (result.output_text ?? "").trim()
  return { answerText, sources, queries }
}
