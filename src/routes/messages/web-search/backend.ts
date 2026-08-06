import type {
  ResponseOutputMessage,
  ResponsesResult,
} from "~/services/copilot/create-responses"

export interface WebSearchSource {
  url: string
  title: string
  snippet?: string
  page_age?: string | null
}

export interface WebSearchExtract {
  /** The grounded answer text produced by the GPT backend (with inline cites). */
  answerText: string
  /** Deduped citation and included action sources. */
  sources: Array<WebSearchSource>
  /** Search queries the backend actually ran. */
  queries: Array<string>
}

export interface WebSearchToolConfig {
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
  userLocation?: Record<string, unknown>
  searchContextSize?: "low" | "medium" | "high"
}

interface UrlCitationAnnotation {
  type: "url_citation"
  url: string
  title?: string
  start_index?: number
  end_index?: number
}

/** Builds the Responses API web_search tool object from normalized config. */
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
  if (config.searchContextSize) {
    tool.search_context_size = config.searchContextSize
  }
  return tool
}

const isMessageItem = (
  item: ResponsesResult["output"][number],
): item is ResponseOutputMessage => item.type === "message"

const isValidUrlCitation = (
  annotation: unknown,
  seenUrls: Set<string>,
): annotation is UrlCitationAnnotation => {
  const ann = annotation as UrlCitationAnnotation
  return (
    ann.type === "url_citation" && Boolean(ann.url) && !seenUrls.has(ann.url)
  )
}

const collectTextParts = (
  blocks:
    | Array<{ type?: string; text?: string; annotations?: Array<unknown> }>
    | undefined,
  seenUrls: Set<string>,
): { textParts: Array<string>; sources: Array<WebSearchSource> } => {
  const textParts: Array<string> = []
  const sources: Array<WebSearchSource> = []
  for (const block of blocks ?? []) {
    if (block.type !== "output_text") continue
    if (block.text) textParts.push(block.text)
    for (const annotation of block.annotations ?? []) {
      if (!isValidUrlCitation(annotation, seenUrls)) continue
      const ann = annotation
      seenUrls.add(ann.url)
      const start = Math.max(0, (ann.start_index ?? 0) - 120)
      const end = Math.min(
        block.text?.length ?? 0,
        (ann.end_index ?? block.text?.length ?? 0) + 120,
      )
      sources.push({
        url: ann.url,
        title: ann.title ?? ann.url,
        snippet: block.text?.slice(start, end).trim(),
      })
    }
  }
  return { textParts, sources }
}

const collectQuery = (
  item: { action?: { query?: string; queries?: Array<string> } },
  queries: Array<string>,
): void => {
  if (item.action?.queries?.length) {
    queries.push(...item.action.queries)
  } else if (item.action?.query) {
    queries.push(item.action.query)
  }
}

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
      const collected = collectTextParts(item.content, seenUrls)
      textParts.push(...collected.textParts)
      sources.push(...collected.sources)
    }
  }

  for (const item of result.output) {
    if ((item as { type?: string }).type === "web_search_call") {
      const action = (
        item as {
          action?: {
            query?: string
            queries?: Array<string>
            sources?: Array<{ url?: string }>
          }
        }
      ).action
      collectQuery({ action }, queries)
      for (const source of action?.sources ?? []) {
        if (!source.url || seenUrls.has(source.url)) continue
        seenUrls.add(source.url)
        sources.push({ url: source.url, title: source.url })
      }
    }
  }

  const answerText =
    textParts.join("\n\n").trim() || (result.output_text ?? "").trim()
  return { answerText, sources, queries }
}
