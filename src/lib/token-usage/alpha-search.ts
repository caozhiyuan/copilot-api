import { recordTokenUsageEvent } from "./index"

// https://api-docs.deepseek.com/guides/search/#billing
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const DEEPSEEK_COST_PER_OPERATION = { CNY: 5 / 1000, USD: 0.75 / 1000 }

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function parseObject(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value) as unknown)
  } catch {
    return {}
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

async function deepSeekCost(
  response: Response,
  payload: Record<string, unknown>,
  currency: "CNY" | "USD",
): Promise<number | undefined> {
  const unitCost = DEEPSEEK_COST_PER_OPERATION[currency]
  if (response.status !== 200) return 0
  let result: Record<string, unknown>
  try {
    result = object(await response.clone().json())
  } catch {
    return undefined
  }

  const tools = object(object(result.usage).server_tool_use)
  const reportedCounts = [
    tools.tool_search,
    tools.tool_fetch,
    tools.tool_image_search,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  )
  if (reportedCounts.length > 0) {
    return (
      reportedCounts.reduce((sum, value) => sum + Math.floor(value), 0)
      * unitCost
    )
  }

  // Alpha Search need not report successful operation counts. Estimate from
  // the submitted commands; batch partial failures cannot be reconciled here.
  const commands = object(payload.commands)
  const hasResults =
    Array.isArray(result.results) ?
      result.results.length > 0
    : Boolean(text(result.output))
  const searches = hasResults ? count(commands.search_query) : 0
  const fetches =
    text(result.output) ? count(commands.open) + count(commands.find) : 0
  return (searches + fetches) * unitCost
}

/** Records only requests sent to a native Alpha Search endpoint. */
export async function recordNativeAlphaSearchUsage(
  response: Response,
  options: {
    providerName: string
    requestBody: ArrayBuffer
    requestHeaders: Headers
    officialDeepSeek?: boolean
    pricingCurrency?: string
  },
): Promise<void> {
  const payload = parseObject(new TextDecoder().decode(options.requestBody))
  const metadata = parseObject(
    options.requestHeaders.get("x-codex-turn-metadata") ?? "",
  )
  const model = text(payload.model) ?? "unknown"
  const prefix = `${options.providerName}/`
  const usageModel =
    model.startsWith(prefix) ? model.slice(prefix.length) : model
  const pricingCurrency =
    (
      options.officialDeepSeek
      && (options.pricingCurrency ?? "CNY").trim().toUpperCase() === "CNY"
    ) ?
      "CNY"
    : "USD"
  recordTokenUsageEvent({
    endpoint: "alpha_search",
    source: "provider",
    providerName: options.providerName,
    pricingCurrency,
    model: `${usageModel}_search`,
    sessionId: text(metadata.session_id) ?? text(metadata.thread_id),
    fallbackSessionId: text(payload.id),
    cost:
      options.providerName === "codex" ? 0
      : options.officialDeepSeek ?
        await deepSeekCost(response, payload, pricingCurrency)
      : undefined,
  })
}
