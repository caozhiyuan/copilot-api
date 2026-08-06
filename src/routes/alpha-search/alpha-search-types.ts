import { z } from "zod"

const unsignedInteger = z.number().int().nonnegative()
const passthroughRecord = z.record(z.string(), z.unknown())

const searchQuerySchema = z
  .object({
    q: z.string(),
    recency: unsignedInteger.optional(),
    domains: z.array(z.string()).optional(),
  })
  .passthrough()

const openOperationSchema = z
  .object({
    ref_id: z.string(),
    lineno: unsignedInteger.optional(),
  })
  .passthrough()

const clickOperationSchema = z
  .object({
    ref_id: z.string(),
    id: unsignedInteger,
  })
  .passthrough()

const findOperationSchema = z
  .object({
    ref_id: z.string(),
    pattern: z.string(),
  })
  .passthrough()

const screenshotOperationSchema = z
  .object({
    ref_id: z.string(),
    pageno: unsignedInteger,
  })
  .passthrough()

const financeOperationSchema = z
  .object({
    ticker: z.string(),
    type: z.enum(["equity", "fund", "crypto", "index"]),
    market: z.string().optional(),
  })
  .passthrough()

const weatherOperationSchema = z
  .object({
    location: z.string(),
    start: z.string().optional(),
    duration: unsignedInteger.optional(),
  })
  .passthrough()

const sportsOperationSchema = z
  .object({
    tool: z.literal("sports").optional(),
    fn: z.enum(["schedule", "standings"]),
    league: z.enum([
      "nba",
      "wnba",
      "nfl",
      "nhl",
      "mlb",
      "epl",
      "ncaamb",
      "ncaawb",
      "ipl",
    ]),
    team: z.string().optional(),
    opponent: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    num_games: unsignedInteger.optional(),
    locale: z.string().optional(),
  })
  .passthrough()

const timeOperationSchema = z
  .object({
    utc_offset: z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/u),
  })
  .passthrough()

export const alphaSearchCommandsSchema = z
  .object({
    search_query: z.array(searchQuerySchema).optional(),
    image_query: z.array(searchQuerySchema).optional(),
    open: z.array(openOperationSchema).optional(),
    click: z.array(clickOperationSchema).optional(),
    find: z.array(findOperationSchema).optional(),
    screenshot: z.array(screenshotOperationSchema).optional(),
    finance: z.array(financeOperationSchema).optional(),
    weather: z.array(weatherOperationSchema).optional(),
    sports: z.array(sportsOperationSchema).optional(),
    time: z.array(timeOperationSchema).optional(),
    response_length: z.enum(["short", "medium", "long"]).optional(),
  })
  .passthrough()

const reasoningSchema = z
  .object({
    effort: z.string().min(1).nullable().optional(),
    summary: z
      .enum(["auto", "concise", "detailed", "none"])
      .nullable()
      .optional(),
    context: z
      .enum(["auto", "current_turn", "all_turns"])
      .nullable()
      .optional(),
  })
  .passthrough()

const settingsSchema = z
  .object({
    user_location: z
      .object({
        type: z.literal("approximate"),
        country: z.string().optional(),
        region: z.string().optional(),
        city: z.string().optional(),
        timezone: z.string().optional(),
      })
      .passthrough()
      .optional(),
    search_context_size: z.enum(["low", "medium", "high"]).optional(),
    filters: z
      .object({
        allowed_domains: z.array(z.string()).optional(),
        blocked_domains: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    image_settings: z
      .object({
        max_results: unsignedInteger.optional(),
        caption: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    allowed_callers: z
      .array(z.enum(["direct", "shell", "code_interpreter"]))
      .optional(),
    external_web_access: z
      .union([z.boolean(), z.enum(["cached", "indexed", "live"])])
      .optional(),
  })
  .passthrough()

export const alphaSearchRequestSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    reasoning: reasoningSchema.optional(),
    input: z.union([z.string(), z.array(passthroughRecord)]).optional(),
    commands: alphaSearchCommandsSchema.optional(),
    settings: settingsSchema.optional(),
    max_output_tokens: unsignedInteger.optional(),
  })
  .passthrough()

export type AlphaSearchRequest = z.infer<typeof alphaSearchRequestSchema>
export type AlphaSearchCommands = z.infer<typeof alphaSearchCommandsSchema>

export interface AlphaSearchResponse {
  encrypted_output: string | null
  output: string
  results: Array<AlphaSearchResult>
}

export type AlphaSearchResult = AlphaSearchTextResult

export interface AlphaSearchTextResult {
  type: "text_result"
  domain: string
  ref_id: string
  snippet: string
  title: string
  url: string
}
