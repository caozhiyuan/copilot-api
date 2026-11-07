import { createHash } from "node:crypto"

import { parseProviderModelAlias } from "~/lib/provider-model"

import type { NamespaceTool, ResponsesPayload } from "~/lib/types/responses"

import {
  CUSTOM_TOOL_INPUT_SCHEMA,
  ResponsesMessagesTranslationError,
  TOOL_NAME_PATTERN,
  type MessagesToolDescriptor,
  type MessagesToolRegistry,
  type ToolRegistration,
} from "./constants"
import {
  getArrayField,
  getItemType,
  getOptionalStringField,
  getStringField,
  isRecord,
} from "./parse"

export function createToolRegistry(
  payload: ResponsesPayload,
  model: string,
): MessagesToolRegistry {
  // Claude-family upstream models skip strict custom tools. Match the upstream
  // model id only, so a provider prefix such as "claude-relay/" does not count.
  const upstreamModel = parseProviderModelAlias(model)?.model ?? model
  const strictCustomTools = !upstreamModel.toLowerCase().includes("claude")
  const registry: MessagesToolRegistry = {
    byAlias: new Map(),
    byOriginal: new Map(),
    tools: [],
  }

  for (const tool of payload.tools ?? []) {
    registerTool(tool, registry, strictCustomTools)
  }

  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      const type = getItemType(item)
      if (type !== "additional_tools") continue
      for (const tool of getArrayField(item, "tools")) {
        registerTool(tool, registry, strictCustomTools)
      }
      break
    }
  }

  return registry
}

export const EXEC_COMMAND_TOOL_NAME = "exec_command"

/**
 * Reports whether the request exposes a direct `exec_command` tool, at the top
 * level, inside a namespace, or through `input.additional_tools`. The
 * additional_tools items are scanned in place, so no tool list is copied.
 */
export function hasExecCommandTool(payload: ResponsesPayload): boolean {
  if ((payload.tools ?? []).some(isExecCommandTool)) return true
  if (!Array.isArray(payload.input)) return false

  for (const item of payload.input) {
    if (getItemType(item) !== "additional_tools") continue
    if (getArrayField(item, "tools").some(isExecCommandTool)) return true
    break
  }
  return false
}

export function isExecCommandTool(tool: unknown): boolean {
  if (getStringField(tool, "name") === EXEC_COMMAND_TOOL_NAME) return true
  if (!isNamespaceTool(tool)) return false
  return tool.tools.some(isExecCommandTool)
}

export function isNamespaceTool(tool: unknown): tool is NamespaceTool {
  return getStringField(tool, "type") === "namespace"
}

export function registerTool(
  tool: unknown,
  registry: MessagesToolRegistry,
  strictCustomTools: boolean,
  namespaces: Array<string> = [],
): void {
  if (!isRecord(tool)) {
    throw new ResponsesMessagesTranslationError(
      "Invalid Responses tool definition",
    )
  }

  const type = getStringField(tool, "type")
  if (type === "namespace") {
    const namespaceTool = tool as unknown as NamespaceTool
    const namespace = getStringField(namespaceTool, "name")
    if (!namespace || !Array.isArray(namespaceTool.tools)) {
      throw new ResponsesMessagesTranslationError(
        "Responses namespace tools require a name and tools array",
      )
    }
    for (const child of namespaceTool.tools) {
      registerTool(child, registry, strictCustomTools, [
        ...namespaces,
        namespace,
      ])
    }
    return
  }

  if (type !== "function" && type !== "custom") {
    const suffix = type ? ` '${type}'` : " without a type"
    throw new ResponsesMessagesTranslationError(
      `Responses Messages fallback does not support tool${suffix}`,
    )
  }

  const name = getStringField(tool, "name")
  if (!name) {
    throw new ResponsesMessagesTranslationError(
      `Responses ${type} tools require a non-empty name`,
    )
  }

  registerMessagesTool(
    {
      kind: type,
      name,
      namespace: namespaces.length > 0 ? namespaces.join(".") : undefined,
      description: getOptionalStringField(tool, "description"),
      parameters:
        type === "function" && isRecord(tool.parameters) ?
          tool.parameters
        : null,
    },
    registry,
    strictCustomTools,
  )
}

export function registerMessagesTool(
  registration: ToolRegistration,
  registry: MessagesToolRegistry,
  strictCustomTools: boolean,
): MessagesToolDescriptor {
  const originalKey = createOriginalToolKey(registration)
  const existing = registry.byOriginal.get(originalKey)
  if (existing) return existing

  const descriptor = createMessagesToolDescriptor(registration, registry)
  registry.byAlias.set(descriptor.alias, descriptor)
  registry.byOriginal.set(originalKey, descriptor)
  registry.tools.push({
    name: descriptor.alias,
    ...(registration.description ?
      { description: registration.description }
    : {}),
    input_schema:
      registration.kind === "custom" ?
        CUSTOM_TOOL_INPUT_SCHEMA
      : (registration.parameters ?? { type: "object", properties: {} }),
    ...(registration.kind === "custom" && strictCustomTools ?
      { strict: true }
    : {}),
  })
  return descriptor
}

export function createMessagesToolDescriptor(
  registration: Pick<ToolRegistration, "kind" | "name" | "namespace">,
  registry: MessagesToolRegistry,
): MessagesToolDescriptor {
  const originalKey = createOriginalToolKey(registration)
  const preferredName =
    registration.namespace && registration.namespace !== "functions" ?
      `${registration.namespace.replaceAll(".", "_")}__${registration.name}`
    : registration.name
  const alias = createToolAlias(preferredName, originalKey, registry)
  return {
    alias,
    kind: registration.kind,
    name: registration.name,
    ...(registration.namespace ? { namespace: registration.namespace } : {}),
  }
}

export function findOriginalDescriptor(
  registry: MessagesToolRegistry,
  kind: MessagesToolDescriptor["kind"],
  name: string,
  namespace?: string,
): MessagesToolDescriptor | undefined {
  return (
    registry.byOriginal.get(createOriginalToolKey({ kind, name, namespace }))
    ?? (!namespace ?
      registry.byOriginal.get(
        createOriginalToolKey({ kind, name, namespace: "functions" }),
      )
    : undefined)
  )
}

export function createOriginalToolKey(
  tool: Pick<MessagesToolDescriptor, "kind" | "name" | "namespace">,
): string {
  return [tool.kind, tool.namespace ?? "", tool.name].join("\u0000")
}

export function createToolAlias(
  preferredName: string,
  originalKey: string,
  registry: MessagesToolRegistry,
): string {
  if (
    TOOL_NAME_PATTERN.test(preferredName)
    && !registry.byAlias.has(preferredName)
  ) {
    return preferredName
  }

  const sanitized = preferredName.replace(/[^A-Za-z0-9_-]+/gu, "_")
  const hash = createStableHash(originalKey).slice(0, 12)
  const prefix = `tool_${hash}_`
  const alias = `${prefix}${sanitized}`.slice(0, 64)
  if (!registry.byAlias.has(alias)) return alias
  return `tool_${createStableHash(`${originalKey}:collision`)}`.slice(0, 64)
}

export function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}
