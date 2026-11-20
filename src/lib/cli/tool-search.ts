export const BRIDGE_TOOL_SEARCH_NAME = "mcp__tool_search__search"
export const BRIDGE_TOOL_SEARCH_ALIASES = [
  BRIDGE_TOOL_SEARCH_NAME,
  "tool_search_search",
  "mcp__plugin_tool-search_tool_search__search",
] as const
export const MCP_TOOL_SEARCH_SENTINEL_TYPE = "copilot_api_tool_search"
export const CLAUDE_TOOL_SEARCH_NAME = "ToolSearch"
export const CLAUDE_DEFERRED_TOOL_PLACEHOLDER_NAME = "DeferredToolPlaceholder"

export type ResponsesToolSearchMode = "native" | "bridge" | "disabled"

export const ALWAYS_LOADED_TOOL_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "ListAgents",
  "Read",
  "ReportFindings",
  "ScheduleWakeup",
  "Skill",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "Workflow",
  "Write",
  "apply_patch",
  "bash",
  "glob",
  "grep",
  "plan_exit",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
] as const

const alwaysLoadedToolNameSet = new Set<string>(ALWAYS_LOADED_TOOL_NAMES)
const bridgeToolSearchNameSet = new Set<string>(BRIDGE_TOOL_SEARCH_ALIASES)

export interface ToolSearchToolLike {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  defer_loading?: boolean
}

export interface McpToolSearchSentinel {
  type: typeof MCP_TOOL_SEARCH_SENTINEL_TYPE
  names: Array<string>
}

export const isBridgeToolSearchName = (name: string): boolean =>
  bridgeToolSearchNameSet.has(name)

export const isAlwaysLoadedToolName = (name: string): boolean =>
  alwaysLoadedToolNameSet.has(name)

export const isDeferredToolName = (name: string): boolean =>
  !isBridgeToolSearchName(name) && !isAlwaysLoadedToolName(name)

export const supportsResponsesToolSearchModel = (model: string): boolean => {
  const match = /^gpt-(\d+)(?:\.(\d+))?/iu.exec(model)
  if (!match) {
    return false
  }

  const major = Number.parseInt(match[1], 10)
  const minor = match[2] ? Number.parseInt(match[2], 10) : 0

  return major > 5 || (major === 5 && minor >= 4)
}

export const hasBridgeToolSearchTool = (
  tools: Array<ToolSearchToolLike> | undefined,
): boolean =>
  Array.isArray(tools)
  && tools.some((tool) => isBridgeToolSearchName(tool.name))

export const resolveBridgeToolSearchName = (
  tools: Array<ToolSearchToolLike> | undefined,
): string => {
  if (!Array.isArray(tools)) {
    return BRIDGE_TOOL_SEARCH_NAME
  }

  return (
    tools.find((tool) => isBridgeToolSearchName(tool.name))?.name
    ?? BRIDGE_TOOL_SEARCH_NAME
  )
}

export const hasDeferredToolCandidate = (
  tools: Array<ToolSearchToolLike> | undefined,
): boolean =>
  Array.isArray(tools) && tools.some((tool) => isDeferredToolName(tool.name))

export const shouldEnableResponsesToolSearch = (params: {
  model: string
  tools?: Array<ToolSearchToolLike>
}): boolean =>
  supportsResponsesToolSearchModel(params.model)
  && hasBridgeToolSearchTool(params.tools)
  && hasDeferredToolCandidate(params.tools)

export const resolveResponsesToolSearchMode = (params: {
  model: string
  tools?: Array<ToolSearchToolLike>
}): ResponsesToolSearchMode => {
  if (!supportsResponsesToolSearchModel(params.model)) {
    return "disabled"
  }

  if (params.tools?.some((tool) => tool.name === CLAUDE_TOOL_SEARCH_NAME)) {
    return "native"
  }

  return shouldEnableResponsesToolSearch(params) ? "bridge" : "disabled"
}

export const resolveResponsesToolSearchName = (params: {
  model: string
  tools?: Array<ToolSearchToolLike>
}): string =>
  resolveResponsesToolSearchMode(params) === "native" ?
    CLAUDE_TOOL_SEARCH_NAME
  : resolveBridgeToolSearchName(params.tools)

export const listDeferredToolNames = (
  tools: Array<ToolSearchToolLike>,
): Array<string> => [
  ...new Set(
    tools
      .filter((tool) => isDeferredToolName(tool.name))
      .map((tool) => tool.name),
  ),
]

const extractDeferredToolNamesSource = (
  record: Record<string, unknown>,
): unknown => record.names ?? record.query ?? record.paths

export const parseDeferredToolNames = (names: unknown): Array<string> => {
  let rawNames: Array<string> = []

  if (typeof names === "string") {
    rawNames = names.split(",")
  } else if (Array.isArray(names)) {
    rawNames = names.flatMap((name) =>
      typeof name === "string" ? name.split(",") : [],
    )
  }

  return [
    ...new Set(
      rawNames.map((name) => name.trim()).filter((name) => name.length > 0),
    ),
  ]
}

export const createMcpToolSearchSentinel = (names: unknown): string =>
  JSON.stringify({
    type: MCP_TOOL_SEARCH_SENTINEL_TYPE,
    names: parseDeferredToolNames(names),
  } satisfies McpToolSearchSentinel)

export const parseMcpToolSearchSentinel = (
  text: string,
): McpToolSearchSentinel | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object") {
      return null
    }

    const record = parsed as Record<string, unknown>
    if (record.type !== MCP_TOOL_SEARCH_SENTINEL_TYPE) {
      return null
    }

    const names = parseDeferredToolNames(extractDeferredToolNamesSource(record))
    if (names.length === 0) {
      return null
    }

    return {
      type: MCP_TOOL_SEARCH_SENTINEL_TYPE,
      names,
    }
  } catch {
    return null
  }
}

export const normalizeToolSearchBridgeArguments = (
  argumentsValue: Record<string, unknown> | string,
): Record<string, unknown> => {
  if (typeof argumentsValue !== "string") {
    const names = parseDeferredToolNames(
      extractDeferredToolNamesSource(argumentsValue),
    )
    return names.length > 0 ? { names } : {}
  }

  try {
    const parsed: unknown = JSON.parse(argumentsValue)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const names = parseDeferredToolNames(
        extractDeferredToolNamesSource(record),
      )
      return names.length > 0 ? { names } : {}
    }
  } catch {
    // Treat a raw string as the comma-separated protocol payload.
  }

  const names = parseDeferredToolNames(argumentsValue)
  return names.length > 0 ? { names } : {}
}

export const formatToolSearchBridgeArguments = (
  argumentsValue: Record<string, unknown> | string,
): Record<string, unknown> => {
  const normalized = normalizeToolSearchBridgeArguments(argumentsValue)
  const names = normalized.names

  if (!Array.isArray(names) || names.length === 0) {
    return {}
  }

  return { names: names.join(",") }
}

export const formatToolSearchArguments = (
  argumentsValue: Record<string, unknown> | string,
  toolSearchName: string,
): Record<string, unknown> => {
  if (toolSearchName !== CLAUDE_TOOL_SEARCH_NAME) {
    return formatToolSearchBridgeArguments(argumentsValue)
  }

  if (typeof argumentsValue !== "string") {
    return argumentsValue && !Array.isArray(argumentsValue) ?
        argumentsValue
      : {}
  }

  try {
    const parsed: unknown = JSON.parse(argumentsValue)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
        (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export const selectDeferredToolsByNames = (
  names: unknown,
  tools: Array<ToolSearchToolLike>,
): Array<ToolSearchToolLike> => {
  const requestedNames = parseDeferredToolNames(names)
  if (requestedNames.length === 0) {
    return []
  }

  const deferredToolByName = new Map(
    tools
      .filter((tool) => isDeferredToolName(tool.name))
      .map((tool) => [tool.name, tool]),
  )

  return requestedNames.flatMap((name) => {
    const tool = deferredToolByName.get(name)
    return tool ? [tool] : []
  })
}
