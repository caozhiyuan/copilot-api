import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { Model } from "~/lib/types/models"

import { COMPACT_REQUEST } from "~/lib/compact"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import {
  RICH_TOOL_RESULT_MOVED_TEXT,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import { getCompactType } from "~/routes/messages/preprocess"

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

// Zod schema for the entire chat completion request payload.
// This is derived from the openapi.documented.yml specification.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  reasoning_effort: z.string().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
})

/**
 * Validates if a request payload conforms to the OpenAI Chat Completion v1 shape using Zod.
 * @param payload The request payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

function getTextParts(
  content: string | Array<{ type: string; text?: string }> | null | undefined,
): Array<string> {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? [content] : []
  }

  return content.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  )
}

function createThinkingModel(): Model {
  return {
    capabilities: {
      family: "gpt",
      limits: {
        max_output_tokens: 4096,
      },
      object: "model_capabilities",
      supports: {
        max_thinking_budget: 3000,
        min_thinking_budget: 1024,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id: "gpt-thinking",
    model_picker_enabled: true,
    name: "gpt-thinking",
    object: "model",
    preview: false,
    supported_endpoints: [],
    vendor: "openai",
    version: "1",
  }
}

describe("Anthropic to OpenAI translation logic", () => {
  test("shares the main agent metadata cache key with marked subagents", () => {
    for (const agentId of ["agent-a", "agent-b"]) {
      const payload: AnthropicMessagesPayload = {
        model: "qwen-plus",
        max_tokens: 128,
        metadata: { user_id: JSON.stringify({ session_id: "root" }) },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<system-reminder>__SUBAGENT_MARKER__${JSON.stringify({ session_id: "child", agent_id: agentId, agent_type: "Explore" })}</system-reminder>`,
              },
            ],
          },
        ],
      }

      expect(translateToOpenAI(payload).prompt_cache_key).toBe("root")
    }
  })

  test("maps request session affinity to prompt_cache_key", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: " opencode-session ",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () => translateToOpenAI(anthropicPayload),
    )

    expect(openAIPayload.prompt_cache_key).toBe("opencode-session")
  })

  test("omits prompt_cache_key when request session affinity is blank", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "   ",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () => translateToOpenAI(anthropicPayload),
    )

    expect(openAIPayload).not.toHaveProperty("prompt_cache_key")
  })

  test("should translate minimal Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
    expect(openAIPayload.model).toBe("gpt-4o")
    expect(openAIPayload.messages).toEqual([
      { role: "user", content: "Hello!" },
    ])
    expect(openAIPayload).not.toHaveProperty("reasoning_effort")
  })

  test("omits tool_choice when tools are absent or empty", () => {
    const choices: Array<NonNullable<AnthropicMessagesPayload["tool_choice"]>> =
      [
        { type: "auto" },
        { type: "any" },
        { type: "none" },
        { type: "tool", name: "getWeather" },
      ]

    for (const tools of [undefined, []]) {
      for (const toolChoice of choices) {
        const result = translateToOpenAI({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello!" }],
          max_tokens: 150,
          tools,
          tool_choice: toolChoice,
        })

        expect(result.tool_choice).toBeUndefined()
        expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty(
          "tool_choice",
        )
      }
    }
  })

  test("preserves tool choices when tools are available", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Check the weather" }],
      max_tokens: 150,
      tools: [{ name: "getWeather", input_schema: { type: "object" } }],
    }

    expect(translateToOpenAI(payload).tool_choice).toBeUndefined()
    expect(
      translateToOpenAI({ ...payload, tool_choice: { type: "auto" } })
        .tool_choice,
    ).toBe("auto")
    expect(
      translateToOpenAI({ ...payload, tool_choice: { type: "any" } })
        .tool_choice,
    ).toBe("required")
    expect(
      translateToOpenAI({ ...payload, tool_choice: { type: "none" } })
        .tool_choice,
    ).toBe("none")
    expect(
      translateToOpenAI({
        ...payload,
        tool_choice: { type: "tool", name: "getWeather" },
      }).tool_choice,
    ).toEqual({ type: "function", function: { name: "getWeather" } })
  })

  test("maps disable_parallel_tool_use without letting a missing flag imply false", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Check the weather" }],
      max_tokens: 150,
      tools: [{ name: "getWeather", input_schema: { type: "object" } }],
    }

    const disabled = translateToOpenAI({
      ...payload,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    })
    const enabled = translateToOpenAI({
      ...payload,
      tool_choice: {
        type: "tool",
        name: "getWeather",
        disable_parallel_tool_use: false,
      },
    })
    const omitted = translateToOpenAI({
      ...payload,
      tool_choice: { type: "auto" },
    })
    const withoutTools = translateToOpenAI({
      model: payload.model,
      messages: payload.messages,
      max_tokens: payload.max_tokens,
      tool_choice: { type: "none", disable_parallel_tool_use: true },
    })

    expect(disabled.parallel_tool_calls).toBe(false)
    expect(disabled.tool_choice).toBe("auto")
    expect(Object.hasOwn(disabled, "parallel_tool_calls")).toBe(true)
    expect(enabled.parallel_tool_calls).toBe(true)
    expect(enabled.tool_choice).toEqual({
      type: "function",
      function: { name: "getWeather" },
    })
    expect(omitted).not.toHaveProperty("parallel_tool_calls")
    expect(withoutTools.tool_choice).toBeUndefined()
    expect(withoutTools.parallel_tool_calls).toBe(false)
  })

  test("should translate comprehensive Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: "user-123" },
      tools: [
        {
          name: "getWeather",
          description: "Gets weather info",
          input_schema: { location: { type: "string" } },
          strict: true,
        },
      ],
      tool_choice: { type: "auto" },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(openAIPayload.tools?.[0]?.function.strict).toBe(true)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("maps inline Anthropic system messages to OpenAI user messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Hello!" },
        { role: "system", content: "Follow the repo style." },
        {
          role: "system",
          content: [{ type: "text", text: "Keep the change focused." }],
        },
      ],
      max_tokens: 128,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      { role: "user", content: "Hello!" },
      { role: "user", content: "Follow the repo style." },
      {
        role: "user",
        content: [{ type: "text", text: "Keep the change focused." }],
      },
    ])
  })

  test("maps non-empty output_config effort to reasoning_effort", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
      output_config: {
        effort: "high",
      },
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.reasoning_effort).toBe("high")
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("maps thinking budget within selected model limits", () => {
    const originalModels = state.models
    state.models = {
      object: "list",
      data: [createThinkingModel()],
    }

    try {
      const anthropicPayload: AnthropicMessagesPayload = {
        model: "gpt-thinking",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 0,
        thinking: {
          type: "enabled",
        },
      }

      const openAIPayload = translateToOpenAI(anthropicPayload)

      expect(openAIPayload.thinking_budget).toBeUndefined()
    } finally {
      state.models = originalModels
    }
  })

  test("should skip assistant messages with empty content array", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Hello!" },
        { role: "assistant", content: [] },
        { role: "user", content: "Are you there?" },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      { role: "user", content: "Hello!" },
      { role: "user", content: "Are you there?" },
    ])
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this simple math problem...",
              signature: "abc123",
            },
            { type: "text", text: "2+2 equals 4." },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is combined with text content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.reasoning_text).toContain(
      "Let me think about this simple math problem...",
    )
    expect(getTextParts(assistantMessage?.content)).toContain("2+2 equals 4.")
  })

  test("should handle thinking blocks with tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I need to call the weather API to get current weather information.",
              signature: "def456",
            },
            { type: "text", text: "I'll check the weather for you." },
            {
              type: "tool_use",
              id: "call_123",
              name: "get_weather",
              input: { location: "New York" },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is included in the message content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.reasoning_text).toContain(
      "I need to call the weather API",
    )
    expect(getTextParts(assistantMessage?.content)).toContain(
      "I'll check the weather for you.",
    )
    expect(assistantMessage?.tool_calls).toHaveLength(1)
    expect(assistantMessage?.tool_calls?.[0].function.name).toBe("get_weather")
  })

  test("should map tool_reference tool results into chat tool messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_123",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "tool_123",
        content: "Tool AskUserQuestion loaded",
      },
    ])
  })
})

describe("tool content support translation", () => {
  test("moves Copilot image tool results to a user message by default", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_image",
              content: [
                {
                  type: "text",
                  text: "screenshot",
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "image-data",
                  },
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "tool_image",
        content: "screenshot",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Tool result for tool_image:",
          },
          {
            type: "text",
            text: "screenshot",
          },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,image-data",
            },
          },
        ],
      },
    ])
  })

  test("downgrades PDFs and moves rich Copilot tool results to a user message by default", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_pdf",
              content: [
                {
                  type: "text",
                  text: "screenshot",
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "image-data",
                  },
                },
                {
                  type: "text",
                  text: "PDF file read: report.pdf",
                },
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "pdf-data",
                  },
                  title: "report.pdf",
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "tool_pdf",
        content:
          "screenshot\nPDF file read: report.pdf\nPDF/document content is not supported by this Chat Completions upstream. Use the available text extracted from the document.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Tool result for tool_pdf:",
          },
          {
            type: "text",
            text: "screenshot",
          },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,image-data",
            },
          },
          {
            type: "text",
            text: "PDF file read: report.pdf",
          },
          {
            type: "text",
            text: "PDF/document content is not supported by this Chat Completions upstream. Use the available text extracted from the document.",
          },
        ],
      },
    ])
  })
})

describe("provider tool content support translation", () => {
  test("uses string-only tool content when provider support is empty", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "qwen-plus",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_text",
              content: [
                {
                  type: "text",
                  text: "line one",
                },
                {
                  type: "text",
                  text: "line two",
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload, {
      toolContentSupportType: [],
    })

    expect(openAIPayload.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "tool_text",
        content: "line one\nline two",
      },
    ])
  })

  test("rewrites provider image tool results when image support is not configured", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "qwen-plus",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_image",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: "image-data",
                  },
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload, {
      toolContentSupportType: [],
    })

    expect(openAIPayload.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "tool_image",
        content: RICH_TOOL_RESULT_MOVED_TEXT,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Tool result for tool_image:",
          },
          {
            type: "image_url",
            image_url: {
              url: "data:image/jpeg;base64,image-data",
            },
          },
        ],
      },
    ])
  })

  test("keeps a matching tool message before moved rich tool content", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "qwen-plus",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_image",
              name: "read_image",
              input: { path: "screenshot.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_image",
              content: [
                {
                  type: "text",
                  text: "screenshot captured",
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "image-data",
                  },
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload, {
      toolContentSupportType: [],
    })

    expect(openAIPayload.messages).toHaveLength(3)
    expect(openAIPayload.messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "tool_image",
          type: "function",
          function: {
            name: "read_image",
            arguments: '{"path":"screenshot.png"}',
          },
        },
      ],
    })
    expect(openAIPayload.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tool_image",
      content: "screenshot captured",
    })
    expect(openAIPayload.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Tool result for tool_image:",
        },
        {
          type: "text",
          text: "screenshot captured",
        },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,image-data",
          },
        },
      ],
    })
  })
})

describe("provider tool result ordering", () => {
  test("keeps all tool result messages contiguous before moved rich user content", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "qwen-plus",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_image",
              name: "read_image",
              input: { path: "screenshot.png" },
            },
            {
              type: "tool_use",
              id: "tool_text",
              name: "read_text",
              input: { path: "log.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_image",
              content: [
                {
                  type: "text",
                  text: "screenshot captured",
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "image-data",
                  },
                },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "tool_text",
              content: [
                {
                  type: "text",
                  text: "line one",
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload, {
      toolContentSupportType: [],
    })

    expect(openAIPayload.messages).toHaveLength(4)
    expect(openAIPayload.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tool_image",
      content: "screenshot captured",
    })
    expect(openAIPayload.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "tool_text",
      content: "line one",
    })
    expect(openAIPayload.messages[3]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Tool result for tool_image:",
        },
        {
          type: "text",
          text: "screenshot captured",
        },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,image-data",
          },
        },
      ],
    })
  })
})

describe("compact request detection", () => {
  test("detects current compact summary prompts in string content", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content: `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.\n\n7. Pending Tasks:\n   - [Task 1]\n\n8. Current Work:\n   [Current work]`,
        },
      ],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(COMPACT_REQUEST)
  })

  test("detects compact prompts in user text blocks while ignoring system reminders", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>\nThe user opened a file.\n</system-reminder>",
            },
            {
              type: "text",
              text: `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.\n\n7. Pending Tasks:\n   - [Task 1]\n\n8. Current Work:\n   [Current work]`,
            },
          ],
        },
      ],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(COMPACT_REQUEST)
  })

  test("does not treat ordinary user quotes as compact prompts", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content:
            'Please explain this prompt: "Your task is to create a detailed summary of the conversation so far"',
        },
      ],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(0)
  })

  test("keeps legacy system prompt compact detection", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      system:
        "You are a helpful AI assistant tasked with summarizing conversations for future continuation.",
      messages: [{ role: "user", content: "continue" }],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(COMPACT_REQUEST)
  })
})
