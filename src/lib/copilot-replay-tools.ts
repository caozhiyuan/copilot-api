import { z } from "zod"

import { HTTPError } from "./http/error"
import { createHandlerLogger } from "./logger"
import type { ResponsesPayload } from "./types/responses"

const logger = createHandlerLogger("copilot-replay-tools")
const functionSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    parameters: z.record(z.string(), z.unknown()),
    strict: z.boolean().nullable(),
  })
  .passthrough()
const toolsSchema = z
  .array(
    z.discriminatedUnion("type", [
      functionSchema,
      z
        .object({
          type: z.literal("namespace"),
          name: z.string().min(1),
          description: z.string().min(1),
          tools: z.array(functionSchema).min(1),
        })
        .passthrough(),
    ]),
  )
  .min(1)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function containsCiphertext(value: unknown): boolean {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === "string" && /^gAAAA[A-Za-z0-9_-]{30,}/.test(current))
      return true
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry)
      continue
    }
    if (!isRecord(current)) continue
    if (current._oai_encrypted === true) return true
    for (const entry of Object.values(current)) pending.push(entry)
  }
  return false
}

function isEncryptedFunctionCall(item: Record<string, unknown>): boolean {
  if (item.type !== "function_call") return false
  if (
    (typeof item.encrypted_content === "string" && item.encrypted_content)
    || (typeof item.encrypted_function_args === "string"
      && item.encrypted_function_args)
  )
    return true
  if (typeof item.arguments !== "string") return false
  if (/^gAAAA[A-Za-z0-9_-]{30,}/.test(item.arguments)) return true
  try {
    return containsCiphertext(JSON.parse(item.arguments))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    logger.warn(
      "Tool-less replay contains non-JSON function arguments; leaving upstream validation unchanged.",
    )
    return false
  }
}

function hasEncryptedToolHistory(input: Array<unknown>): boolean {
  return input.some((item) => {
    if (!isRecord(item)) return false
    if (isEncryptedFunctionCall(item)) return true
    return (
      item.type === "agent_message"
      && Array.isArray(item.content)
      && item.content.some(
        (block: unknown) =>
          isRecord(block)
          && block.type === "encrypted_content"
          && typeof block.encrypted_content === "string"
          && block.encrypted_content.length > 0,
      )
    )
  })
}

const toolKey = (namespace: unknown, name: unknown): string =>
  JSON.stringify([namespace ?? "functions", name])

function failReplayConfiguration(): never {
  const message =
    "copilotResponsesReplayTools must contain the original function declarations, with no duplicate names, covering the encrypted calls in this request. No history was changed or forwarded."
  throw new HTTPError(
    message,
    Response.json(
      {
        error: {
          type: "configuration_error",
          code: "invalid_replay_tools",
          message,
        },
      },
      { status: 500 },
    ),
  )
}

export function restoreCopilotReplayTools(
  payload: ResponsesPayload,
  originalTools: unknown,
): ResponsesPayload {
  const { input, tools, tool_choice: toolChoice } = payload
  if (
    originalTools === undefined
    || !Array.isArray(input)
    || (tools != null && (!Array.isArray(tools) || tools.length > 0))
    || (toolChoice !== undefined
      && toolChoice !== "auto"
      && toolChoice !== "none")
  )
    return payload

  // A history-carried catalog is authoritative; never substitute another one.
  if (
    input.some(
      (item) =>
        isRecord(item)
        && (item.type === "additional_tools"
          || item.type === "tool_search_output")
        && Array.isArray(item.tools)
        && item.tools.length > 0,
    )
    || !hasEncryptedToolHistory(input)
  )
    return payload

  const parsed = toolsSchema.safeParse(originalTools)
  if (!parsed.success) failReplayConfiguration()
  const keys = new Set<string>()
  const namespaces = new Set<string>()
  for (const tool of parsed.data) {
    if (tool.type === "namespace") {
      if (namespaces.has(tool.name)) failReplayConfiguration()
      namespaces.add(tool.name)
    }
    const functions = tool.type === "namespace" ? tool.tools : [tool]
    for (const declaration of functions) {
      const key = toolKey(
        tool.type === "namespace" ? tool.name : undefined,
        declaration.name,
      )
      if (keys.has(key)) failReplayConfiguration()
      keys.add(key)
    }
  }
  for (const item of input) {
    if (
      isRecord(item)
      && isEncryptedFunctionCall(item)
      && !keys.has(toolKey(item.namespace, item.name))
    )
      failReplayConfiguration()
  }

  logger.info(
    `Restored ${keys.size} configured original function declaration(s) for tool-less encrypted replay; tool calls disabled.`,
  )
  return {
    ...payload,
    tools: structuredClone(parsed.data),
    tool_choice: "none",
    parallel_tool_calls: false,
  }
}
