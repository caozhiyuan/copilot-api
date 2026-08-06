import type { Context } from "hono"
import consola from "consola"

import { resolveMappedModel } from "~/lib/config"
import { debugJson, createHandlerLogger } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import {
  createCopilotTokenUsageRecorder,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  alphaSearchRequestSchema,
  type AlphaSearchResponse,
  type AlphaSearchTextResult,
} from "~/routes/alpha-search/alpha-search-types"
import {
  buildResponsesWebSearchTool,
  extractWebSearchResult,
  type WebSearchSource,
} from "~/routes/messages/web-search/backend"
import {
  createResponses as createCopilotResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

const logger = createHandlerLogger("alpha-search-copilot-handler")

const SESSION_TTL_MS = 60 * 60 * 1000
const MAX_SESSIONS = 128
const MAX_URL_REFERENCES = 256
const MAX_SNAPSHOTS = 16
const MAX_SNAPSHOT_CHARACTERS = 20_000
// ponytail: bounded process-local state is intentional; use persistent
// per-account storage only if measured sessions outgrow these fixed ceilings.

const IMAGE_UNSUPPORTED =
  "Unsupported by GitHub Copilot web search: image_query. Do not retry this operation; use search_query for image-source pages."
const SCREENSHOT_UNSUPPORTED =
  "Unsupported by GitHub Copilot web search: screenshot. Do not retry this operation; open the PDF for text content."

const KNOWN_COMMANDS = new Set([
  "search_query",
  "image_query",
  "open",
  "click",
  "find",
  "screenshot",
  "finance",
  "weather",
  "sports",
  "time",
  "response_length",
])

interface UrlReference {
  result: AlphaSearchTextResult
}

interface PageSnapshot {
  refId: string
  source: UrlReference
  text: string
  links: Array<UrlReference>
}

interface SearchSession {
  nextTurn: number
  touchedAt: number
  referencesById: Map<string, UrlReference>
  referencesByUrl: Map<string, UrlReference>
  snapshots: Map<string, PageSnapshot>
}

interface RemotePageOperation {
  kind: "open" | "find"
  source: UrlReference
  lineno?: number
  pattern?: string
}

interface SearchTurn {
  number: number
  nextReferenceIndex: number
}

const sessions = new Map<string, SearchSession>()

export const alphaSearchFallbackDependencies = {
  createResponses: createCopilotResponses,
  findEndpointModel,
  now: (): number => Date.now(),
  resolveMappedModel,
  createUsageRecorder: (
    model: string,
    sessionId: string,
  ): ((usage: UsageTokens) => void) =>
    createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: sessionId,
      model,
    }),
}

export function resetAlphaSearchFallbackState(): void {
  sessions.clear()
}

function reserveSession(
  id: string,
  now: number,
): {
  session: SearchSession
  turn: number
} {
  for (const [sessionId, session] of sessions) {
    if (now - session.touchedAt >= SESSION_TTL_MS) {
      sessions.delete(sessionId)
    }
  }

  let session = sessions.get(id)
  if (!session) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldestSession = sessions.keys().next()
      if (!oldestSession.done) sessions.delete(oldestSession.value)
    }
    session = {
      nextTurn: 0,
      touchedAt: now,
      referencesById: new Map(),
      referencesByUrl: new Map(),
      snapshots: new Map(),
    }
  } else {
    sessions.delete(id)
    session.touchedAt = now
  }
  sessions.set(id, session)

  const turn = session.nextTurn
  session.nextTurn += 1
  return { session, turn }
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ?
        url.toString()
      : null
  } catch {
    return null
  }
}

function extractMarkdownSources(text: string): Array<WebSearchSource> {
  // ponytail: Copilot emits simple Markdown links here; add a Markdown parser
  // only if measured responses exceed this shape.
  return Array.from(
    text.matchAll(
      /(?<!!)\[([^\]\n]+)\]\((https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)\)/gu,
    ),
    ([, title, url]) => ({ title, url }),
  )
}

function addUrlReference(
  session: SearchSession,
  source: WebSearchSource,
  turn: SearchTurn,
): UrlReference | null {
  const url = parseHttpUrl(source.url)
  if (!url) return null

  const existing = session.referencesByUrl.get(url)
  if (existing) {
    if (existing.result.title === existing.result.url && source.title) {
      existing.result.title = source.title
    }
    if (source.snippet) existing.result.snippet = source.snippet
    return existing
  }

  if (session.referencesById.size >= MAX_URL_REFERENCES) {
    const oldest = session.referencesById.entries().next().value
    if (oldest) {
      const [refId, reference] = oldest
      session.referencesById.delete(refId)
      session.referencesByUrl.delete(reference.result.url)
    }
  }

  const refId = `turn${turn.number}search${turn.nextReferenceIndex}`
  turn.nextReferenceIndex += 1

  const reference: UrlReference = {
    result: {
      type: "text_result",
      domain: new URL(url).hostname,
      ref_id: refId,
      snippet: source.snippet?.trim() || source.title || url,
      title: source.title || url,
      url,
    },
  }
  session.referencesById.set(refId, reference)
  session.referencesByUrl.set(url, reference)
  return reference
}

function resolveUrlReference(
  session: SearchSession,
  refId: string,
  turn: SearchTurn,
): UrlReference | null {
  const stored = session.referencesById.get(refId)
  if (stored) return stored

  const url = parseHttpUrl(refId)
  return url ? addUrlReference(session, { title: url, url }, turn) : null
}

function getSnapshot(
  session: SearchSession,
  refId: string,
): PageSnapshot | null {
  const snapshot = session.snapshots.get(refId)
  if (!snapshot) return null
  session.snapshots.delete(refId)
  session.snapshots.set(refId, snapshot)
  return snapshot
}

function findSnapshotByUrl(
  session: SearchSession,
  url: string,
): PageSnapshot | null {
  for (const snapshot of session.snapshots.values()) {
    if (snapshot.source.result.url === url) {
      return getSnapshot(session, snapshot.refId)
    }
  }
  return null
}

function addSnapshot(
  session: SearchSession,
  source: UrlReference,
  turn: number,
  index: number,
  text: string,
  links: Array<UrlReference>,
): PageSnapshot {
  const existing = findSnapshotByUrl(session, source.result.url)
  if (existing) {
    existing.text = text.slice(0, MAX_SNAPSHOT_CHARACTERS)
    existing.links = links
    return existing
  }

  if (session.snapshots.size >= MAX_SNAPSHOTS) {
    const oldestRefId = session.snapshots.keys().next().value
    if (oldestRefId) session.snapshots.delete(oldestRefId)
  }

  const snapshot = {
    refId: `turn${turn}view${index}`,
    source,
    text: text.slice(0, MAX_SNAPSHOT_CHARACTERS),
    links,
  }
  session.snapshots.set(snapshot.refId, snapshot)
  return snapshot
}

function renderSnapshot(snapshot: PageSnapshot, lineno?: number): string {
  const lines = snapshot.text.split("\n")
  const start =
    lineno === undefined ? 0 : (
      Math.max(0, Math.min(lineno, lines.length - 1) - 10)
    )
  const end =
    lineno === undefined ? lines.length : Math.min(lines.length, start + 21)
  const numbered = lines
    .slice(start, end)
    .map((line, index) => `L${start + index}: ${line}`)
    .join("\n")
  const links = snapshot.links
    .map(
      (link, index) =>
        `[${index}] ${link.result.title} — ${link.result.url} (${link.result.ref_id})`,
    )
    .join("\n")

  return [
    `Open ${snapshot.refId} (${snapshot.source.result.url})`,
    numbered,
    links ? `Links:\n${links}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function findInSnapshot(
  snapshot: PageSnapshot,
  pattern: string,
): string | null {
  const normalizedPattern = pattern.toLowerCase()
  const matches = snapshot.text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.toLowerCase().includes(normalizedPattern))
    .slice(0, 20)
  if (matches.length === 0) return null

  return [
    `Find results for ${JSON.stringify(pattern)} in ${snapshot.refId}:`,
    ...matches.map(({ line, index }) => `L${index}: ${line}`),
  ].join("\n")
}

function formatTime(utcOffset: string, now: number): string {
  const direction = utcOffset[0] === "+" ? 1 : -1
  const offsetMinutes =
    direction
    * (Number.parseInt(utcOffset.slice(1, 3), 10) * 60
      + Number.parseInt(utcOffset.slice(4, 6), 10))
  const localIso = new Date(now + offsetMinutes * 60_000).toISOString()
  return `Time at UTC${utcOffset}: ${localIso.slice(0, 19).replace("T", " ")}`
}

function buildInstruction(
  operations: Array<Record<string, unknown>>,
  responseLength: "short" | "medium" | "long" | undefined,
): string {
  return [
    "The Operations JSON below is the complete and exclusive request for this response.",
    "Use web_search to execute every listed operation and only those operations. Do not validate, infer, or mention operations absent from the JSON; the adapter already handled them.",
    "Return only grounded results and citations for these operations. Do not discuss unrelated tasks or conversations.",
    "For search operations, honor every query, recency, domain, market, date, league, team, and locale constraint.",
    "For open operations, open the exact URL and return grounded page text plus cited links.",
    "For find operations, find the exact pattern in the specified URL and return matching context.",
    `Requested response length: ${responseLength ?? "medium"}.`,
    `Operations:\n${JSON.stringify(operations, null, 2)}`,
  ].join("\n")
}

function unavailableReference(refId: string): string {
  return `Reference ${JSON.stringify(refId)} is unavailable or expired. Search or open the URL again.`
}

function invalidRequest(c: Context, message: string): Response {
  return c.json(
    {
      error: {
        message,
        type: "invalid_request_error",
      },
    },
    400,
  )
}

export async function handleCopilotAlphaSearch(c: Context): Promise<Response> {
  let body: unknown
  try {
    body = await c.req.json<unknown>()
  } catch {
    return invalidRequest(c, "Invalid alpha search request: expected JSON body")
  }

  const parsed = alphaSearchRequestSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join(".") || "body"
    return invalidRequest(
      c,
      `Invalid alpha search request at ${path}: ${issue?.message ?? "invalid value"}`,
    )
  }

  const request = parsed.data
  const now = alphaSearchFallbackDependencies.now()
  const reservation = reserveSession(request.id, now)
  const session = reservation.session
  const turn: SearchTurn = {
    number: reservation.turn,
    nextReferenceIndex: 0,
  }
  const commands = request.commands ?? {}
  const output: Array<string> = []
  const warnings: Array<string> = []
  const resultReferences = new Map<string, UrlReference>()
  const remoteOperations: Array<Record<string, unknown>> = []
  const remotePages: Array<RemotePageOperation> = []

  const includeResult = (reference: UrlReference): void => {
    resultReferences.set(reference.result.url, reference)
  }
  const queuePage = (
    kind: "open" | "find",
    source: UrlReference,
    options: { lineno?: number; pattern?: string } = {},
  ): void => {
    remoteOperations.push({
      type: kind,
      url: source.result.url,
      ...(options.lineno === undefined ? {} : { lineno: options.lineno }),
      ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
    })
    remotePages.push({ kind, source, ...options })
    includeResult(source)
  }

  for (const command of commands.search_query ?? []) {
    remoteOperations.push({ ...command, type: "search_query" })
  }

  if ((commands.image_query?.length ?? 0) > 0) warnings.push(IMAGE_UNSUPPORTED)

  for (const command of commands.open ?? []) {
    const directSnapshot = getSnapshot(session, command.ref_id)
    if (directSnapshot) {
      output.push(renderSnapshot(directSnapshot, command.lineno))
      includeResult(directSnapshot.source)
      continue
    }

    const source = resolveUrlReference(session, command.ref_id, turn)
    if (!source) {
      output.push(unavailableReference(command.ref_id))
      continue
    }
    const cached = findSnapshotByUrl(session, source.result.url)
    if (cached) {
      output.push(renderSnapshot(cached, command.lineno))
      includeResult(source)
      continue
    }
    queuePage("open", source, { lineno: command.lineno })
  }

  for (const command of commands.click ?? []) {
    const parent = getSnapshot(session, command.ref_id)
    const source = parent?.links[command.id]
    if (!source) {
      output.push(unavailableReference(`${command.ref_id} link ${command.id}`))
      continue
    }
    const cached = findSnapshotByUrl(session, source.result.url)
    if (cached) {
      output.push(renderSnapshot(cached))
      includeResult(source)
      continue
    }
    queuePage("open", source)
  }

  for (const command of commands.find ?? []) {
    const directSnapshot = getSnapshot(session, command.ref_id)
    const source =
      directSnapshot?.source
      ?? resolveUrlReference(session, command.ref_id, turn)
    if (!source) {
      output.push(unavailableReference(command.ref_id))
      continue
    }
    const snapshot =
      directSnapshot ?? findSnapshotByUrl(session, source.result.url)
    const localResult =
      snapshot ? findInSnapshot(snapshot, command.pattern) : null
    if (localResult) {
      output.push(localResult)
      includeResult(source)
      continue
    }
    queuePage("find", source, { pattern: command.pattern })
  }

  if ((commands.screenshot?.length ?? 0) > 0) {
    warnings.push(SCREENSHOT_UNSUPPORTED)
  }

  for (const command of commands.finance ?? []) {
    remoteOperations.push({ ...command, type: "finance" })
  }
  for (const command of commands.weather ?? []) {
    remoteOperations.push({ ...command, type: "weather" })
  }
  for (const command of commands.sports ?? []) {
    remoteOperations.push({ ...command, type: "sports" })
  }
  for (const command of commands.time ?? []) {
    output.push(formatTime(command.utc_offset, now))
  }

  for (const commandName of Object.keys(commands)) {
    if (!KNOWN_COMMANDS.has(commandName)) {
      warnings.push(
        `Unsupported by GitHub Copilot web search: ${commandName}. Do not retry this operation.`,
      )
    }
  }

  const externalWebAccess = request.settings?.external_web_access
  const liveAccess =
    externalWebAccess === undefined
    || externalWebAccess === true
    || externalWebAccess === "live"

  if (remoteOperations.length > 0 && !liveAccess) {
    warnings.push(
      `GitHub Copilot alpha search supports live retrieval only; external_web_access=${JSON.stringify(externalWebAccess)} is unsupported. Do not retry this request in this mode.`,
    )
  }

  if (remoteOperations.length > 0 && liveAccess) {
    const model = alphaSearchFallbackDependencies.resolveMappedModel(
      request.model,
    )
    const selectedModel =
      alphaSearchFallbackDependencies.findEndpointModel(model)
    if (!selectedModel?.supported_endpoints?.includes("/responses")) {
      return invalidRequest(
        c,
        `Model '${model}' does not support the Copilot Responses endpoint required for alpha search`,
      )
    }

    const instruction = buildInstruction(
      remoteOperations,
      commands.response_length,
    )
    const sessionId = getUUID(request.id)
    const requestId = generateRequestIdFromPayload(
      { messages: `${turn.number}:${instruction}` },
      sessionId,
    )
    const responsesPayload: ResponsesPayload = {
      model,
      input: instruction,
      tools: [
        buildResponsesWebSearchTool({
          allowedDomains: request.settings?.filters?.allowed_domains,
          blockedDomains: request.settings?.filters?.blocked_domains,
          userLocation: request.settings?.user_location,
          searchContextSize: request.settings?.search_context_size,
        }),
      ],
      tool_choice: "required",
      store: false,
      stream: false,
      include: ["web_search_call.action.sources"],
      reasoning: request.reasoning as ResponsesPayload["reasoning"],
      max_output_tokens: request.max_output_tokens,
    }

    debugJson(
      logger,
      "Alpha search Copilot Responses request:",
      responsesPayload,
    )
    const result = (await alphaSearchFallbackDependencies.createResponses(
      responsesPayload,
      {
        vision: false,
        initiator: "agent",
        transport: "http",
        requestId,
        sessionId,
      },
    )) as ResponsesResult
    debugJson(logger, "Alpha search Copilot Responses result:", result)

    alphaSearchFallbackDependencies.createUsageRecorder(
      model,
      sessionId,
    )({
      ...normalizeResponsesUsage(result.usage),
      total_nano_aiu: normalizeOptionalToken(
        result.copilot_usage?.total_nano_aiu,
      ),
    })

    const extracted = extractWebSearchResult(result)
    const citedSources = extracted.sources.filter(
      (source) => source.snippet !== undefined,
    )
    const relevantSources =
      citedSources.length > 0 ? citedSources : extracted.sources
    consola.log(
      `--> web search: operations=${[
        ...new Set(remoteOperations.map((operation) => operation.type)),
      ].join(
        ",",
      )} queries=${JSON.stringify(extracted.queries)} sources=${relevantSources.length}`,
    )
    const remoteReferences = relevantSources
      .map((source) => addUrlReference(session, source, turn))
      .filter((reference): reference is UrlReference => Boolean(reference))
    const activeRemoteReferences = (): Array<UrlReference> =>
      remoteReferences.filter(
        (reference) =>
          session.referencesById.get(reference.result.ref_id) === reference,
      )
    for (const reference of activeRemoteReferences()) includeResult(reference)

    const answerText =
      extracted.answerText || "GitHub Copilot web search returned no text."
    const markdownReferences =
      remotePages.length === 0 ?
        []
      : extractMarkdownSources(answerText)
          .map((source) => addUrlReference(session, source, turn))
          .filter((reference): reference is UrlReference => Boolean(reference))
    for (const reference of markdownReferences) includeResult(reference)
    if (remotePages.length === 0) output.push(answerText)

    for (const [index, page] of remotePages.entries()) {
      const target =
        addUrlReference(
          session,
          {
            url: page.source.result.url,
            title: page.source.result.title,
            snippet: answerText,
          },
          turn,
        ) ?? page.source
      includeResult(target)
      const snapshotLinks = [
        ...new Map(
          [...markdownReferences, ...activeRemoteReferences()]
            .filter(
              (reference) =>
                reference.result.url !== target.result.url
                && session.referencesById.get(reference.result.ref_id)
                  === reference,
            )
            .map((reference) => [reference.result.url, reference] as const),
        ).values(),
      ]

      if (page.kind === "find") {
        output.push(
          `Find results for ${JSON.stringify(page.pattern ?? "")} in ${target.result.url}:\n${answerText}`,
        )
        if (!findSnapshotByUrl(session, target.result.url)) {
          addSnapshot(
            session,
            target,
            turn.number,
            index,
            answerText,
            snapshotLinks,
          )
        }
        continue
      }

      const snapshot = addSnapshot(
        session,
        target,
        turn.number,
        index,
        answerText,
        snapshotLinks,
      )
      output.push(renderSnapshot(snapshot, page.lineno))
    }

    const activeSources = activeRemoteReferences()
    if (activeSources.length > 0) {
      output.push(
        [
          "Sources:",
          ...activeSources.map(
            (reference) =>
              `- [${reference.result.ref_id}] ${reference.result.title} — ${reference.result.url}`,
          ),
        ].join("\n"),
      )
    }
  }

  output.push(...warnings)
  if (output.length === 0) {
    output.push("No supported search operations were requested.")
  }

  const response: AlphaSearchResponse = {
    encrypted_output: null,
    output: output.join("\n\n"),
    results: [...resultReferences.values()]
      .filter(
        (reference) =>
          session.referencesById.get(reference.result.ref_id) === reference,
      )
      .map(({ result }) => result),
  }
  return c.json(response)
}
