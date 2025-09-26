import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ResponsesPayload {
  model: string
  input?: string | Array<ResponseInputItem>
  instructions?: string | Array<ResponseInputItem> | null
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  tools?: Array<Record<string, unknown>> | null
  tool_choice?: unknown
  metadata?: Record<string, unknown> | null
  stream?: boolean | null
  response_format?: Record<string, unknown> | null
  user?: string | null
  parallel_tool_calls?: boolean | null
  frequency_penalty?: number | null
  presence_penalty?: number | null
  stop?: string | Array<string> | null
  seed?: number | null
  logprobs?: boolean | null
  n?: number | null
  [key: string]: unknown
}

export interface ResponseInputMessage {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content?: string | Array<ResponseInputContent>
  status?: string
}

export type ResponseInputItem = ResponseInputMessage | Record<string, unknown>

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage
  | ResponseContentTextLike
  | Record<string, unknown>

export interface ResponseInputText {
  type?: "input_text" | "text" | "output_text"
  text: string
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail?: "low" | "high" | "auto"
}

export interface ResponseContentTextLike {
  type?: "text"
  text: string
}

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponseOutputMessage>
  output_text: string
  status: string
  usage?: ResponseUsage | null
  error: Record<string, unknown> | null
  incomplete_details: Record<string, unknown> | null
  instructions: string | null
  metadata: Record<string, unknown> | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: unknown
  tools: Array<Record<string, unknown>>
  top_p: number | null
}

export interface ResponseOutputMessage {
  id: string
  type: "message"
  role: "assistant"
  status: "completed" | "in_progress" | "incomplete"
  content: Array<ResponseOutputText>
}

export interface ResponseOutputText {
  type: "output_text"
  text: string
  annotations: Array<unknown>
}

export interface ResponseUsage {
  prompt_tokens: number
  completion_tokens?: number
  total_tokens: number
  [key: string]: unknown
}

export type ResponsesStream = ReturnType<typeof events>
export type CreateResponsesReturn = ResponsesResult | ResponsesStream

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
}

export const createResponses = async (
  payload: ResponsesPayload,
  { vision, initiator }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, vision),
    "X-Initiator": initiator,
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResult
}
