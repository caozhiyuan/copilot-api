import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"

import type { WebSearchExtract } from "~/routes/messages/web-search/backend"

const ENDPOINT = "https://search.parallel.ai/mcp"
const USER_AGENT = "copilot-api (https://github.com/caozhiyuan/copilot-api)"
// The gateway has no persistent conversation store. A process-local secret makes
// a client's conversation ID opaque without retaining IDs or forwarding metadata.
const sessionSecret = randomBytes(32)

export const parallelSearchDependencies = {
  fetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
  timeoutMs: 30_000,
}

const searchResultSchema = z.object({
  results: z.array(
    z.object({
      url: z.url(),
      title: z.string().nullable().optional(),
      excerpts: z.array(z.string()),
    }),
  ),
})

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})

const matchesDomain = (hostname: string, domain: string): boolean => {
  const normalized = domain.toLowerCase().replace(/^\./, "")
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

export const searchParallelWeb = async (options: {
  query: string
  conversationId?: string
  signal: AbortSignal
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
}): Promise<WebSearchExtract> => {
  const { query, conversationId, allowedDomains, blockedDomains } = options
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(parallelSearchDependencies.timeoutMs),
  ])
  signal.throwIfAborted()
  const sessionId =
    conversationId ?
      createHmac("sha256", sessionSecret).update(conversationId).digest("hex")
    : randomUUID()
  const client = new Client({ name: "copilot-api", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: (url, init) =>
      parallelSearchDependencies.fetch(url, {
        ...init,
        // Include every SDK request: initialization, discovery and tool calls.
        headers: new Headers({
          ...Object.fromEntries(new Headers(init?.headers)),
          "User-Agent": USER_AGENT,
        }),
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools({}, { signal })
    if (!tools.some((tool) => tool.name === "web_search")) {
      throw new Error("Parallel MCP does not offer web_search")
    }
    const result = toolResultSchema.parse(
      await client.callTool(
        {
          name: "web_search",
          arguments: {
            objective: query,
            search_queries: [
              [
                query,
                ...(allowedDomains?.length ?
                  [
                    `(${allowedDomains.map((domain) => `site:${domain}`).join(" OR ")})`,
                  ]
                : []),
                ...(blockedDomains?.map((domain) => `-site:${domain}`) ?? []),
              ].join(" "),
            ],
            session_id: sessionId,
          },
        },
        undefined,
        { signal },
      ),
    )
    if (result.isError) throw new Error("Parallel web search unavailable")
    const text = result.content.find((block) => block.type === "text")?.text
    const parsed = searchResultSchema.parse(
      result.structuredContent
        ?? JSON.parse(typeof text === "string" ? text : ""),
    )
    const sources = parsed.results
      .filter(({ url }) => {
        const { protocol, hostname } = new URL(url)
        return (
          ["https:", "http:"].includes(protocol)
          && (!allowedDomains?.length
            || allowedDomains.some((domain) => matchesDomain(hostname, domain)))
          && !blockedDomains?.some((domain) => matchesDomain(hostname, domain))
        )
      })
      .map(({ url, title, excerpts }) => ({
        url,
        title: title ?? url,
        snippet: excerpts.join("\n"),
      }))
    return {
      queries: [query],
      sources,
      answerText:
        sources
          .map((source) => `${source.title}\n${source.url}\n${source.snippet}`)
          .join("\n\n") || "No web search results found.",
    }
  } finally {
    await client.close()
  }
}
