import type { ResponsesPayload } from "~/lib/types/responses"

const CLIENT_NAMESPACE = "collaboration"
const UPSTREAM_NAMESPACE = "copilot_collaboration"
const MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"])

interface EncryptionAnnotation {
  present: boolean
  value: unknown
}

interface StreamChunk {
  data?: string
  event?: string
}

export interface CollaborationCompatibility {
  payload: ResponsesPayload
  namespace: string
  restoreResponse: <T>(response: T) => T
  restoreChunk: <T extends StreamChunk>(chunk: T) => T
  plaintextMessages: (responseOrEvent: unknown) => Array<string>
}

// Native collaboration schemas are reserved upstream: changing only their
// encryption annotations is rejected. An ordinary namespace lets Copilot
// produce plain-text arguments while the client retains its own tool names.
// Namespace rewriting never changes argument strings or encrypted content.
export function createCollaborationCompatibility(
  payload: ResponsesPayload,
): CollaborationCompatibility | undefined {
  const namespaces = new Set<string>()
  const annotations = new Map<string, EncryptionAnnotation>()
  let hasCollaborationTools = false

  for (const tools of getToolLists(payload)) {
    for (const tool of tools) {
      if (!isRecord(tool)) continue
      collectNamespace(tool, namespaces)
      if (tool.type === "namespace" && tool.name === CLIENT_NAMESPACE) {
        hasCollaborationTools = true
        if (Array.isArray(tool.tools)) {
          for (const child of tool.tools) rememberAnnotation(child, annotations)
        }
      } else if (isToolReference(tool, CLIENT_NAMESPACE)) {
        hasCollaborationTools = true
        rememberAnnotation(tool, annotations)
      }
    }
  }

  if (!hasCollaborationTools) return undefined

  for (const item of getItems(payload)) collectNamespace(item, namespaces)
  collectChoiceNamespaces(payload.tool_choice, namespaces)

  let namespace = UPSTREAM_NAMESPACE
  for (let suffix = 1; namespaces.has(namespace); suffix += 1) {
    namespace = `${UPSTREAM_NAMESPACE}_${suffix}`
  }

  const adapted = structuredClone(payload)
  rewriteRecord(adapted, CLIENT_NAMESPACE, namespace, annotations, false)
  const knownItems = new Map<string | number, string>()
  const remembered = new Set<string>()

  const plaintextMessages = (value: unknown): Array<string> => {
    const messages: Array<string> = []
    const visit = (record: unknown): void => {
      if (!isRecord(record)) return
      const name =
        typeof record.name === "string" ?
          record.name.slice(record.name.lastIndexOf(".") + 1)
        : undefined
      const isMessageCall =
        isToolReference(record, namespace)
        && name !== undefined
        && MESSAGE_TOOLS.has(name)
      if (
        record.type === "function_call"
        && isMessageCall
        && typeof record.id === "string"
      ) {
        knownItems.set(record.id, name)
      }
      if (
        record.type === "response.output_item.added"
        && isRecord(record.item)
        && record.item.type === "function_call"
      ) {
        const itemName =
          typeof record.item.name === "string" ?
            record.item.name.slice(record.item.name.lastIndexOf(".") + 1)
          : undefined
        if (
          isToolReference(record.item, namespace)
          && itemName
          && MESSAGE_TOOLS.has(itemName)
          && typeof record.output_index === "number"
        ) {
          knownItems.set(record.output_index, itemName)
        }
      }
      const knownName =
        (typeof record.item_id === "string" ?
          knownItems.get(record.item_id)
        : undefined)
        ?? (typeof record.output_index === "number" ?
          knownItems.get(record.output_index)
        : undefined)
      const hasExplicitNamespace =
        typeof record.namespace === "string"
        || (typeof record.name === "string" && record.name.includes("."))
      const knownArgumentEvent =
        record.type === "response.function_call_arguments.done"
        && (isMessageCall
          || (!hasExplicitNamespace
            && knownName !== undefined
            && (record.name === undefined || record.name === knownName)))
      if (
        (record.type === "function_call" && isMessageCall)
        || knownArgumentEvent
      ) {
        const message = readMessageArgument(record.arguments)
        if (message !== undefined && !remembered.has(message)) {
          remembered.add(message)
          messages.push(message)
        }
      }
      for (const nested of [record.item, record.response]) visit(nested)
      if (Array.isArray(record.output))
        for (const item of record.output) visit(item)
    }
    visit(value)
    return messages
  }

  return {
    payload: adapted,
    namespace,
    plaintextMessages,
    restoreResponse: <T>(response: T): T => {
      if (!isRecord(response)) return response
      const restored = structuredClone(response)
      return (
          rewriteRecord(
            restored,
            namespace,
            CLIENT_NAMESPACE,
            annotations,
            true,
          )
        ) ?
          restored
        : response
    },
    restoreChunk: <T extends StreamChunk>(chunk: T): T => {
      if (!chunk.data || chunk.data === "[DONE]") return chunk
      let event: unknown
      try {
        event = JSON.parse(chunk.data)
      } catch {
        return chunk
      }
      if (!isRecord(event)) return chunk
      if (
        !rewriteRecord(event, namespace, CLIENT_NAMESPACE, annotations, true)
      ) {
        return chunk
      }
      return { ...chunk, data: JSON.stringify(event) }
    },
  }
}

function readMessageArgument(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== "string") return undefined
  try {
    const args: unknown = JSON.parse(argumentsValue)
    return isRecord(args) && typeof args.message === "string" ?
        args.message
      : undefined
  } catch {
    return undefined
  }
}

function getItems(
  record: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [record.input, record.output].flatMap((items) =>
    Array.isArray(items) ? items.filter(isRecord) : [],
  )
}

function getToolLists(record: Record<string, unknown>): Array<Array<unknown>> {
  const lists: Array<Array<unknown>> = []
  if (Array.isArray(record.tools)) lists.push(record.tools)
  for (const item of getItems(record)) {
    if (
      (item.type === "additional_tools" || item.type === "tool_search_output")
      && Array.isArray(item.tools)
    ) {
      lists.push(item.tools)
    }
  }
  return lists
}

function collectNamespace(
  record: Record<string, unknown>,
  names: Set<string>,
): void {
  if (record.type === "namespace" && typeof record.name === "string") {
    names.add(record.name)
  }
  if (typeof record.namespace === "string") names.add(record.namespace)
  if (typeof record.name === "string" && record.name.includes(".")) {
    names.add(record.name.slice(0, record.name.indexOf(".")))
  }
}

function collectChoiceNamespaces(choice: unknown, names: Set<string>): void {
  if (!isRecord(choice)) return
  collectNamespace(choice, names)
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    for (const tool of choice.tools) {
      if (isRecord(tool)) collectNamespace(tool, names)
    }
  }
}

function messageSchema(
  tool: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (tool.type !== "function" || typeof tool.name !== "string")
    return undefined
  const name = tool.name.slice(tool.name.lastIndexOf(".") + 1)
  if (!MESSAGE_TOOLS.has(name) || !isRecord(tool.parameters)) return undefined
  const properties = tool.parameters.properties
  return isRecord(properties) && isRecord(properties.message) ?
      properties.message
    : undefined
}

function rememberAnnotation(
  tool: unknown,
  annotations: Map<string, EncryptionAnnotation>,
): void {
  if (!isRecord(tool) || typeof tool.name !== "string") return
  const message = messageSchema(tool)
  if (!message) return
  const name = tool.name.slice(tool.name.lastIndexOf(".") + 1)
  annotations.set(name, {
    present: Object.hasOwn(message, "encrypted"),
    value: message.encrypted,
  })
}

function isToolReference(
  record: Record<string, unknown>,
  namespace: string,
): boolean {
  return (
    record.namespace === namespace
    || (typeof record.name === "string"
      && record.name.startsWith(`${namespace}.`))
  )
}

function rewriteReference(
  record: Record<string, unknown>,
  from: string,
  to: string,
): boolean {
  let changed = false
  if (record.namespace === from) {
    record.namespace = to
    changed = true
  }
  if (typeof record.name === "string" && record.name.startsWith(`${from}.`)) {
    record.name = `${to}${record.name.slice(from.length)}`
    changed = true
  }
  return changed
}

function rewriteAnnotation(
  tool: Record<string, unknown>,
  annotations: Map<string, EncryptionAnnotation>,
  restore: boolean,
): void {
  const message = messageSchema(tool)
  if (!message || typeof tool.name !== "string") return
  const name = tool.name.slice(tool.name.lastIndexOf(".") + 1)
  const original = annotations.get(name)
  if (restore && original?.present) message.encrypted = original.value
  else delete message.encrypted
}

function rewriteTools(
  tools: Array<unknown>,
  from: string,
  to: string,
  annotations: Map<string, EncryptionAnnotation>,
  restore: boolean,
): boolean {
  let changed = false
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    if (tool.type === "namespace" && tool.name === from) {
      tool.name = to
      changed = true
      if (Array.isArray(tool.tools)) {
        for (const child of tool.tools) {
          if (isRecord(child)) rewriteAnnotation(child, annotations, restore)
        }
      }
    } else if (rewriteReference(tool, from, to)) {
      rewriteAnnotation(tool, annotations, restore)
      changed = true
    }
  }
  return changed
}

function rewriteChoice(choice: unknown, from: string, to: string): boolean {
  if (!isRecord(choice)) return false
  let changed = rewriteReference(choice, from, to)
  if (choice.type === "namespace" && choice.name === from) {
    choice.name = to
    changed = true
  }
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    for (const tool of choice.tools) {
      if (rewriteChoice(tool, from, to)) changed = true
    }
  }
  return changed
}

function rewriteRecord(
  record: Record<string, unknown>,
  from: string,
  to: string,
  annotations: Map<string, EncryptionAnnotation>,
  restore: boolean,
): boolean {
  let changed = false
  if (
    record.type === "function_call"
    || record.type === "custom_tool_call"
    || record.type === "response.function_call_arguments.done"
    || record.type === "response.custom_tool_call_input.done"
  ) {
    changed = rewriteReference(record, from, to)
  }
  for (const tools of getToolLists(record)) {
    if (rewriteTools(tools, from, to, annotations, restore)) changed = true
  }
  if (rewriteChoice(record.tool_choice, from, to)) changed = true
  for (const item of getItems(record)) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (rewriteReference(item, from, to)) changed = true
    }
  }
  for (const nested of [record.response, record.item]) {
    if (
      isRecord(nested)
      && rewriteRecord(nested, from, to, annotations, restore)
    ) {
      changed = true
    }
  }
  return changed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
