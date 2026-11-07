import { compactTextOnlyGuard } from "~/lib/compact"
import type {
  AnthropicMessagesPayload,
  AnthropicTool,
} from "~/lib/types/anthropic"
import type {
  ResponseInputItem,
  ResponsesPayload,
  ResponsesTextFormat,
} from "~/lib/types/responses"

export const MESSAGES_COMPACTION_PREFIX = "copilot-api:messages-compaction:v1:"
const MESSAGES_REASONING_ID_SUFFIX = "__a1"

export const markMessagesReasoningId = (id: string): string =>
  `${id}${MESSAGES_REASONING_ID_SUFFIX}`

export const isMessagesReasoningId = (id: unknown): boolean =>
  typeof id === "string" && id.endsWith(MESSAGES_REASONING_ID_SUFFIX)

export const MESSAGES_COMPACTION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "Do NOT continue the task, make changes, or call any tools. Your only output must be the handoff summary.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
  "",
  compactTextOnlyGuard,
].join("\n")

export const MESSAGES_TOOL_CALL_TIPS = [
  "# Tool Call Tips",
  "- Do NOT call `exec_command` directly; that tool does not exist. Use `functions.exec` (tool name: `exec`) to run commands instead.",
  '- The functions.exec tool accepts parameters only as {"input":"..."}; put the complete executable code inside input, including properly constructed tools.exec_command(...) calls and text(...) output handling.',
  "- Construct all tools.exec_command(...) arguments strictly according to its tool definition, and use OS/shell-compatible commands for Windows, Linux, and macOS.",
  "- Always assign the awaited tools.exec_command(...) call to a variable and forward the full result with text(JSON.stringify(r)); unforwarded output is silently dropped and makes results look empty.",
  "- Yielded execution is not truncated output. Resume a running `cell_id` with `functions.wait` (tool name: `wait`), and a live `session_id` with `tools.write_stdin`, until the command reaches a terminal result.",
  "- Read files with the OS-native command (Get-Content/Test-Path on Windows PowerShell, cat/ls on POSIX), quote paths containing spaces, and verify the forwarded output is non-empty before concluding a file was read.",
  "- For long-running commands, keep the returned `session_id` and poll it with `tools.write_stdin` until the command finishes; do not redirect output to a temp file and read it back in a second call.",
  "- If `functions.exec` returns `aborted`, retry at most 3 times. After 3 failures, terminate immediately and inform the user that `functions.exec` is unavailable.",
].join("\n")

export const MESSAGES_BATCH_TOOL_CALL_TIPS = [
  "- Parallel tool calls are disabled for this request. Batch independent commands in one functions.exec call; keep dependent operations sequential.",
  'const results = await Promise.allSettled([tools.exec_command({cmd: "git status --short"})]); for (const result of results) text(JSON.stringify(result.status === "fulfilled" ? result.value : {error: String(result.reason)}))',
].join("\n")

const JSON_OUTPUT_CONSTRAINT =
  "Do not wrap the JSON in markdown code fences and do not add any text outside the JSON object."

export const buildOutputFormatInstruction = (
  format: ResponsesTextFormat | null | undefined,
): string | null => {
  if (!format) return null

  if (format.type === "json_schema") {
    return [
      `Respond with a single JSON object that strictly matches the "${format.name}" JSON schema below.`,
      JSON_OUTPUT_CONSTRAINT,
      "",
      "JSON schema:",
      JSON.stringify(format.schema, null, 2),
    ].join("\n")
  }

  if (format.type === "json_object") {
    return ["Respond with a single JSON object.", JSON_OUTPUT_CONSTRAINT].join(
      "\n",
    )
  }

  return null
}

export const COMPACTION_REPLAY_PROMPT =
  "The previous conversation was compacted. Continue from this handoff summary:\n\n"
export const MAX_DEVELOPER_PROMPTS = 5
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
export const CUSTOM_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
}

export class ResponsesMessagesTranslationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "ResponsesMessagesTranslationError"
    this.status = status
  }
}

export interface MessagesToolDescriptor {
  alias: string
  kind: "custom" | "function"
  name: string
  namespace?: string
}

export interface MessagesToolRegistry {
  byAlias: Map<string, MessagesToolDescriptor>
  byOriginal: Map<string, MessagesToolDescriptor>
  tools: Array<AnthropicTool>
}

export interface ResponsesToMessagesTranslation {
  compaction: boolean
  messagesPayload: AnthropicMessagesPayload
  originalPayload: ResponsesPayload
  publicModel: string
  registry: MessagesToolRegistry
}

export type MessagesResponseTranslationContext = Omit<
  ResponsesToMessagesTranslation,
  "messagesPayload"
>

export interface ToolRegistration {
  description?: string | null
  kind: MessagesToolDescriptor["kind"]
  name: string
  namespace?: string
  parameters?: Record<string, unknown> | null
}

export interface ResponsesInputNormalization {
  compaction: boolean
  input: string | Array<ResponseInputItem> | undefined
}
