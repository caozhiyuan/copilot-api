import type { Context } from "hono"
import consola from "consola"

import {
  resolveEffectiveProviderType,
  resolveMappedModel,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { debugJson, createHandlerLogger } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import {
  createCopilotTokenUsageRecorder,
  createProviderTokenUsageRecorder,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  alphaSearchRequestSchema,
  type AlphaSearchCommands,
  type AlphaSearchRequest,
  type AlphaSearchResponse,
  type AlphaSearchTextResult,
} from "~/routes/alpha-search/alpha-search-types"
import {
  buildResponsesWebSearchTool,
  extractWebSearchResult,
  type WebSearchSource,
} from "~/routes/messages/web-search/backend"
import type { ResponsesPayload, ResponsesResult } from "~/lib/types/responses"
import { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"
import { forwardProviderResponses } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("alpha-search-responses-handler")

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

interface RemoteOperation {
  operation: string
  [key: string]: unknown
}

interface PageOperationOptions {
  lineno?: number
  pattern?: string
}

interface SearchTurn {
  number: number
  nextReferenceIndex: number
}

interface SearchOperationState {
  session: SearchSession
  turn: SearchTurn
  output: Array<string>
  warnings: Array<string>
  resultReferences: Map<string, UrlReference>
  remoteOperations: Array<RemoteOperation>
  remotePages: Array<RemotePageOperation>
}

export interface AlphaSearchResponsesOptions {
  provider?: string
  request: AlphaSearchRequest
}

interface RemoteModelTarget {
  model: string
  providerConfig?: ResolvedProviderConfig
}

const sessions = new Map<string, SearchSession>()

export const alphaSearchResponsesDependencies = {
  createResponses: createCopilotResponses,
  findEndpointModel,
  now: (): number => Date.now(),
  resolveMappedModel,
  resolveEffectiveProviderType,
  resolveProviderConfig,
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

export function resetAlphaSearchState(): void {
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
      /(?<!!)\[([^\]\n]+)\]\((https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)\)/gu, //NOSONAR
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
  const direction = utcOffset.startsWith("+") ? 1 : -1
  const offsetMinutes =
    direction
    * (Number.parseInt(utcOffset.slice(1, 3), 10) * 60
      + Number.parseInt(utcOffset.slice(4, 6), 10))
  const localIso = new Date(now + offsetMinutes * 60_000).toISOString()
  return `Time at UTC${utcOffset}: ${localIso.slice(0, 19).replace("T", " ")}`
}

function buildInstruction(
  operations: Array<RemoteOperation>,
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

function createSearchOperationState(
  session: SearchSession,
  turn: SearchTurn,
): SearchOperationState {
  return {
    session,
    turn,
    output: [],
    warnings: [],
    resultReferences: new Map(),
    remoteOperations: [],
    remotePages: [],
  }
}

function includeResult(
  state: SearchOperationState,
  reference: UrlReference,
): void {
  state.resultReferences.set(reference.result.url, reference)
}

function queuePage(
  state: SearchOperationState,
  kind: "open" | "find",
  source: UrlReference,
  options: PageOperationOptions = {},
): void {
  state.remoteOperations.push({
    operation: kind,
    url: source.result.url,
    ...(options.lineno === undefined ? {} : { lineno: options.lineno }),
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  })
  state.remotePages.push({ kind, source, ...options })
  includeResult(state, source)
}

function processSearchCommands(
  commands: AlphaSearchCommands,
  state: SearchOperationState,
): void {
  for (const command of commands.search_query ?? []) {
    state.remoteOperations.push({ ...command, operation: "search_query" })
  }
}

function processOpenCommands(
  commands: AlphaSearchCommands,
  state: SearchOperationState,
): void {
  for (const command of commands.open ?? []) {
    const directSnapshot = getSnapshot(state.session, command.ref_id)
    if (directSnapshot) {
      state.output.push(renderSnapshot(directSnapshot, command.lineno))
      includeResult(state, directSnapshot.source)
      continue
    }

    const source = resolveUrlReference(
      state.session,
      command.ref_id,
      state.turn,
    )
    if (!source) {
      state.output.push(unavailableReference(command.ref_id))
      continue
    }
    const cached = findSnapshotByUrl(state.session, source.result.url)
    if (cached) {
      state.output.push(renderSnapshot(cached, command.lineno))
      includeResult(state, source)
      continue
    }
    queuePage(state, "open", source, { lineno: command.lineno })
  }
}

function processClickCommands(
  commands: AlphaSearchCommands,
  state: SearchOperationState,
): void {
  for (const command of commands.click ?? []) {
    const parent = getSnapshot(state.session, command.ref_id)
    const source = parent?.links[command.id]
    if (!source) {
      state.output.push(
        unavailableReference(`${command.ref_id} link ${command.id}`),
      )
      continue
    }
    const cached = findSnapshotByUrl(state.session, source.result.url)
    if (cached) {
      state.output.push(renderSnapshot(cached))
      includeResult(state, source)
      continue
    }
    queuePage(state, "open", source)
  }
}

function processFindCommands(
  commands: AlphaSearchCommands,
  state: SearchOperationState,
): void {
  for (const command of commands.find ?? []) {
    const directSnapshot = getSnapshot(state.session, command.ref_id)
    const source =
      directSnapshot?.source
      ?? resolveUrlReference(state.session, command.ref_id, state.turn)
    if (!source) {
      state.output.push(unavailableReference(command.ref_id))
      continue
    }
    const snapshot =
      directSnapshot ?? findSnapshotByUrl(state.session, source.result.url)
    const localResult =
      snapshot ? findInSnapshot(snapshot, command.pattern) : null
    if (localResult) {
      state.output.push(localResult)
      includeResult(state, source)
      continue
    }
    queuePage(state, "find", source, { pattern: command.pattern })
  }
}

function processStructuredCommands(
  commands: AlphaSearchCommands,
  state: SearchOperationState,
  now: number,
): void {
  for (const command of commands.finance ?? []) {
    state.remoteOperations.push({ ...command, operation: "finance" })
  }
  for (const command of commands.weather ?? []) {
    state.remoteOperations.push({ ...command, operation: "weather" })
  }
  for (const command of commands.sports ?? []) {
    state.remoteOperations.push({ ...command, operation: "sports" })
  }
  for (const command of commands.time ?? []) {
    state.output.push(formatTime(command.utc_offset, now))
  }
}

function processUnsupportedCommands(
  commands: AlphaSearchCommands,
  state: SearchOperationState,
): void {
  for (const commandName of Object.keys(commands)) {
    if (!KNOWN_COMMANDS.has(commandName)) {
      state.warnings.push(
        `Unsupported by GitHub Copilot web search: ${commandName}. Do not retry this operation.`,
      )
    }
  }
}

function processCommandOperations(
  commands: AlphaSearchCommands,
  state: SearchOperationState,
  now: number,
): void {
  processSearchCommands(commands, state)
  if ((commands.image_query?.length ?? 0) > 0) {
    state.warnings.push(IMAGE_UNSUPPORTED)
  }
  processOpenCommands(commands, state)
  processClickCommands(commands, state)
  processFindCommands(commands, state)
  if ((commands.screenshot?.length ?? 0) > 0) {
    state.warnings.push(SCREENSHOT_UNSUPPORTED)
  }
  processStructuredCommands(commands, state, now)
  processUnsupportedCommands(commands, state)
}

function supportsLiveAccess(request: AlphaSearchRequest): boolean {
  const externalWebAccess = request.settings?.external_web_access
  return (
    externalWebAccess === undefined
    || externalWebAccess === true
    || externalWebAccess === "live"
  )
}

function addLiveAccessWarning(
  request: AlphaSearchRequest,
  state: SearchOperationState,
): void {
  if (state.remoteOperations.length === 0 || supportsLiveAccess(request)) return
  state.warnings.push(
    `GitHub Copilot alpha search supports live retrieval only; external_web_access=${JSON.stringify(request.settings?.external_web_access)} is unsupported. Do not retry this request in this mode.`,
  )
}

function shouldExecuteRemoteOperations(
  request: AlphaSearchRequest,
  state: SearchOperationState,
): boolean {
  return state.remoteOperations.length > 0 && supportsLiveAccess(request)
}

async function resolveRemoteModel(
  c: Context,
  request: AlphaSearchRequest,
  provider?: string,
): Promise<RemoteModelTarget | Response> {
  const model =
    provider ?
      request.model
    : alphaSearchResponsesDependencies.resolveMappedModel(request.model)
  if (provider) {
    const providerConfig =
      await alphaSearchResponsesDependencies.resolveProviderConfig(provider)
    if (!providerConfig) {
      return c.json(
        {
          error: {
            message: `Provider '${provider}' not found or disabled`,
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    if (
      alphaSearchResponsesDependencies.resolveEffectiveProviderType(
        providerConfig,
        model,
      ) !== "openai-responses"
    ) {
      return invalidRequest(
        c,
        `Provider '${provider}' does not support the /v1/responses endpoint required for alpha search`,
      )
    }

    return { model, providerConfig }
  }

  const selectedModel =
    alphaSearchResponsesDependencies.findEndpointModel(model)
  if (!selectedModel?.supported_endpoints?.includes("/responses")) {
    return invalidRequest(
      c,
      `Model '${model}' does not support the Copilot Responses endpoint required for alpha search`,
    )
  }
  return { model }
}

function createRemoteResponsesPayload(
  request: AlphaSearchRequest,
  model: string,
  instruction: string,
): ResponsesPayload {
  return {
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
}

async function requestProviderSearch(
  c: Context,
  providerConfig: ResolvedProviderConfig,
  payload: ResponsesPayload,
  model: string,
  sessionId: string,
): Promise<ResponsesResult> {
  debugJson(logger, "Alpha search provider Responses request:", {
    payload,
    provider: providerConfig.name,
  })
  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    payload,
    c.req.raw.headers,
    { signal: c.req.raw.signal },
  )
  if (!upstreamResponse.ok) {
    throw new HTTPError(
      `Failed to create ${providerConfig.name} responses for alpha search`,
      upstreamResponse,
    )
  }
  const result = (await upstreamResponse.json()) as ResponsesResult
  debugJson(logger, "Alpha search provider Responses result:", {
    provider: providerConfig.name,
    result,
  })
  createProviderTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: sessionId,
    model,
    pricing: providerConfig.models?.[model]?.pricing,
    pricingCurrency: providerConfig.pricingCurrency,
    providerName: providerConfig.name,
    sessionId,
  })(normalizeResponsesUsage(result.usage))
  return result
}

async function requestCopilotSearch(
  payload: ResponsesPayload,
  model: string,
  requestId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ResponsesResult> {
  debugJson(logger, "Alpha search Copilot Responses request:", payload)
  const result = (await alphaSearchResponsesDependencies.createResponses(
    payload,
    {
      vision: false,
      initiator: "agent",
      transport: "http",
      requestId,
      sessionId,
      signal,
    },
  )) as ResponsesResult
  debugJson(logger, "Alpha search Copilot Responses result:", result)

  alphaSearchResponsesDependencies.createUsageRecorder(
    model,
    sessionId,
  )({
    ...normalizeResponsesUsage(result.usage),
    total_nano_aiu: normalizeOptionalToken(
      result.copilot_usage?.total_nano_aiu,
    ),
  })
  return result
}

async function requestRemoteSearch(
  c: Context,
  request: AlphaSearchRequest,
  state: SearchOperationState,
  target: RemoteModelTarget,
): Promise<ResponsesResult> {
  const instruction = buildInstruction(
    state.remoteOperations,
    request.commands?.response_length,
  )
  const sessionId = getUUID(request.id)
  const requestId = generateRequestIdFromPayload(
    { messages: `${state.turn.number}:${instruction}` },
    sessionId,
  )
  const payload = createRemoteResponsesPayload(
    request,
    target.model,
    instruction,
  )

  if (target.providerConfig) {
    return await requestProviderSearch(
      c,
      target.providerConfig,
      payload,
      target.model,
      sessionId,
    )
  }

  return await requestCopilotSearch(
    payload,
    target.model,
    requestId,
    sessionId,
    c.req.raw.signal,
  )
}

function getActiveRemoteReferences(
  session: SearchSession,
  references: Array<UrlReference>,
): Array<UrlReference> {
  return references.filter(
    (reference) =>
      session.referencesById.get(reference.result.ref_id) === reference,
  )
}

function buildSnapshotLinks(
  state: SearchOperationState,
  target: UrlReference,
  markdownReferences: Array<UrlReference>,
  remoteReferences: Array<UrlReference>,
): Array<UrlReference> {
  return [
    ...new Map(
      [
        ...markdownReferences,
        ...getActiveRemoteReferences(state.session, remoteReferences),
      ]
        .filter(
          (reference) =>
            reference.result.url !== target.result.url
            && state.session.referencesById.get(reference.result.ref_id)
              === reference,
        )
        .map((reference) => [reference.result.url, reference] as const),
    ).values(),
  ]
}

function processRemotePages(
  state: SearchOperationState,
  answerText: string,
  markdownReferences: Array<UrlReference>,
  remoteReferences: Array<UrlReference>,
): void {
  for (const [index, page] of state.remotePages.entries()) {
    const target =
      addUrlReference(
        state.session,
        {
          url: page.source.result.url,
          title: page.source.result.title,
          snippet: answerText,
        },
        state.turn,
      ) ?? page.source
    includeResult(state, target)
    const snapshotLinks = buildSnapshotLinks(
      state,
      target,
      markdownReferences,
      remoteReferences,
    )

    if (page.kind === "find") {
      state.output.push(
        `Find results for ${JSON.stringify(page.pattern ?? "")} in ${target.result.url}:\n${answerText}`,
      )
      if (!findSnapshotByUrl(state.session, target.result.url)) {
        addSnapshot(
          state.session,
          target,
          state.turn.number,
          index,
          answerText,
          snapshotLinks,
        )
      }
      continue
    }

    const snapshot = addSnapshot(
      state.session,
      target,
      state.turn.number,
      index,
      answerText,
      snapshotLinks,
    )
    state.output.push(renderSnapshot(snapshot, page.lineno))
  }
}

function appendActiveSources(
  state: SearchOperationState,
  references: Array<UrlReference>,
): void {
  if (references.length === 0) return
  state.output.push(
    [
      "Sources:",
      ...references.map(
        (reference) =>
          `- [${reference.result.ref_id}] ${reference.result.title} — ${reference.result.url}`,
      ),
    ].join("\n"),
  )
}

function processRemoteResult(
  result: ResponsesResult,
  state: SearchOperationState,
): void {
  const extracted = extractWebSearchResult(result)
  const citedSources = extracted.sources.filter(
    (source) => source.snippet !== undefined,
  )
  const relevantSources =
    citedSources.length > 0 ? citedSources : extracted.sources
  consola.log(
    `--> web search: operations=${[
      ...new Set(
        state.remoteOperations.map(
          (remoteOperation) => remoteOperation.operation,
        ),
      ),
    ].join(
      ",",
    )} queries=${JSON.stringify(extracted.queries)} sources=${relevantSources.length}`,
  )

  const remoteReferences = relevantSources
    .map((source) => addUrlReference(state.session, source, state.turn))
    .filter((reference): reference is UrlReference => Boolean(reference))
  for (const reference of getActiveRemoteReferences(
    state.session,
    remoteReferences,
  )) {
    includeResult(state, reference)
  }

  const answerText =
    extracted.answerText || "GitHub Copilot web search returned no text."
  const markdownReferences =
    state.remotePages.length === 0 ?
      []
    : extractMarkdownSources(answerText)
        .map((source) => addUrlReference(state.session, source, state.turn))
        .filter((reference): reference is UrlReference => Boolean(reference))
  for (const reference of markdownReferences) includeResult(state, reference)
  if (state.remotePages.length === 0) state.output.push(answerText)

  processRemotePages(state, answerText, markdownReferences, remoteReferences)
  appendActiveSources(
    state,
    getActiveRemoteReferences(state.session, remoteReferences),
  )
}

async function executeRemoteOperations(
  c: Context,
  request: AlphaSearchRequest,
  state: SearchOperationState,
  provider?: string,
): Promise<Response | null> {
  const target = await resolveRemoteModel(c, request, provider)
  if (target instanceof Response) return target
  const result = await requestRemoteSearch(c, request, state, target)
  processRemoteResult(result, state)
  return null
}

function buildAlphaSearchResponse(
  state: SearchOperationState,
): AlphaSearchResponse {
  state.output.push(...state.warnings)
  if (state.output.length === 0) {
    state.output.push("No supported search operations were requested.")
  }

  return {
    encrypted_output: null,
    output: state.output.join("\n\n"),
    results: [...state.resultReferences.values()]
      .filter(
        (reference) =>
          state.session.referencesById.get(reference.result.ref_id)
          === reference,
      )
      .map(({ result }) => result),
  }
}

export async function handleAlphaSearchResponses(
  c: Context,
  options: AlphaSearchResponsesOptions,
): Promise<Response> {
  const parsed = alphaSearchRequestSchema.safeParse(options.request)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join(".") || "body"
    return invalidRequest(
      c,
      `Invalid alpha search request at ${path}: ${issue?.message ?? "invalid value"}`,
    )
  }
  const request = parsed.data
  const now = alphaSearchResponsesDependencies.now()
  const reservation = reserveSession(request.id, now)
  const session = reservation.session
  const turn: SearchTurn = {
    number: reservation.turn,
    nextReferenceIndex: 0,
  }
  const state = createSearchOperationState(session, turn)
  const commands = request.commands ?? {}
  processCommandOperations(commands, state, now)

  addLiveAccessWarning(request, state)

  if (shouldExecuteRemoteOperations(request, state)) {
    const remoteResponse = await executeRemoteOperations(
      c,
      request,
      state,
      options.provider,
    )
    if (remoteResponse) return remoteResponse
  }

  return c.json(buildAlphaSearchResponse(state))
}
