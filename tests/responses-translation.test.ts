import { describe, expect, it } from "bun:test"

import { requestContext } from "~/lib/request-context"
import { createMcpToolSearchSentinel } from "~/lib/tool-search"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type {
  ResponseFunctionCallOutputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseToolSearchCallItem,
  ResponseToolSearchOutputItem,
  ResponsesResult,
} from "~/lib/types/responses"

import {
  REASONING_SUMMARY_SEPARATOR,
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"

const samplePayload = {
  model: "claude-3-5-sonnet",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nThis is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.\n</system-reminder>",
        },
        {
          type: "text",
          text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>",
        },
        {
          type: "text",
          text: "hi",
        },
        {
          type: "text",
          text: "<system-reminder>\nThe user opened the file c:\\Work2\\copilot-api\\src\\routes\\responses\\translation.ts in the IDE. This may or may not be related to the current task.\n</system-reminder>",
        },
        {
          type: "text",
          text: "hi",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    },
  ],
} as unknown as AnthropicMessagesPayload

const sampleTools = [
  {
    name: "getWeather",
    description: "Gets weather info",
    input_schema: {
      location: {
        type: "string",
      },
    },
  },
]

const jsonStyleUserId = JSON.stringify({
  device_id: "3f4a1b7c8d9e0f1234567890abcdef1234567890abcdef1234567890abcdef12",
  account_uuid: "",
  session_id: "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752",
})

const legacyStyleUserId =
  "user_8b7e2c1d4f6a9b3c0d1e2f3456789abcdeffedcba9876543210fedcba1234567_account__session_7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b"

const emptySessionUserId = JSON.stringify({
  device_id: "3f4a1b7c8d9e0f1234567890abcdef1234567890abcdef1234567890abcdef12",
  account_uuid: "",
  session_id: "",
})

const translateThinking = (thinking: string): ResponseInputReasoning => {
  const result = translateAnthropicMessagesToResponsesPayload({
    ...samplePayload,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking,
            signature: "encrypted-content@reasoning-id",
          },
        ],
      },
    ],
  })

  return (result.input as Array<ResponseInputReasoning>)[0]
}

describe("translateAnthropicMessagesToResponsesPayload", () => {
  it("keeps empty summaries compatible with legacy Thinking markers", () => {
    expect(translateThinking("").summary).toEqual([])
    expect(translateThinking("Thinking...").summary).toEqual([])
  })

  it("restores marked summary boundaries and preserves unmarked history", () => {
    const firstSummary =
      "**Preparing to search online**\n\nI need to use web.run."
    const secondSummary = "**Running the search**"
    const unmarkedThinking =
      "**Preparing**\n\nDescription\n\n**A bold body line**\n\nMore text"
    const marked = translateThinking(
      firstSummary + REASONING_SUMMARY_SEPARATOR + secondSummary,
    )

    expect(marked.summary).toEqual([
      { type: "summary_text", text: firstSummary },
      { type: "summary_text", text: secondSummary },
    ])
    expect(translateThinking(unmarkedThinking).summary).toEqual([
      { type: "summary_text", text: unmarkedThinking },
    ])
  })

  it("prefers the requested output_config reasoning effort", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      output_config: {
        effort: "xhigh",
      },
    })

    expect(result.reasoning?.effort).toBe("xhigh")
  })

  it("converts anthropic text blocks into response input messages", () => {
    const result = translateAnthropicMessagesToResponsesPayload(samplePayload)

    expect(Array.isArray(result.input)).toBe(true)
    const input = result.input as Array<ResponseInputMessage>
    expect(input).toHaveLength(1)

    const message = input[0]
    expect(message.role).toBe("user")
    expect(Array.isArray(message.content)).toBe(true)

    const content = message.content as Array<{ text: string }>
    expect(content.map((item) => item.text)).toEqual([
      "<system-reminder>\nThis is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.\n</system-reminder>",
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>",
      "hi",
      "<system-reminder>\nThe user opened the file c:\\Work2\\copilot-api\\src\\routes\\responses\\translation.ts in the IDE. This may or may not be related to the current task.\n</system-reminder>",
      "hi",
    ])
  })

  it.each([1024, 32768])(
    "uses concise reasoning and omits the output token limit for Grok with max_tokens %i",
    (maxTokens) => {
      const result = translateAnthropicMessagesToResponsesPayload({
        model: "grok-4",
        max_tokens: maxTokens,
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "Hello" }],
      })

      expect(result.reasoning).toMatchObject({
        effort: "high",
        summary: "concise",
      })
      expect(result).not.toHaveProperty("max_output_tokens")
    },
  )

  it("preserves Grok text arrays, message phase and tool status", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "grok-4",
      max_tokens: 1024,
      top_p: 0.8,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Review the commit." }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I am Codex. I will review the latest commit.",
            },
            {
              type: "tool_use",
              id: "call_review",
              name: "read_commit",
              input: {},
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "" }] },
      ],
    })

    expect(result).not.toHaveProperty("temperature")
    expect(result).not.toHaveProperty("top_p")
    expect(result.include).toEqual(["reasoning.encrypted_content"])
    expect(result.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review the commit." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I am Codex. I will review the latest commit.",
          },
        ],
        phase: "commentary",
      },
      {
        type: "function_call",
        call_id: "call_review",
        name: "read_commit",
        arguments: "{}",
        status: "completed",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
        phase: "final_answer",
      },
    ])
  })

  it.each([
    { system: "Review carefully." },
    {
      system: [
        { type: "text" as const, text: "Review carefully." },
        { type: "text" as const, text: "Preserve details." },
      ],
    },
  ])(
    "moves Grok instructions to the first system message for %j",
    ({ system }) => {
      const result = translateAnthropicMessagesToResponsesPayload({
        model: "grok-4",
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: "First request" }],
      })

      expect(result).not.toHaveProperty("instructions")
      const input = result.input as Array<ResponseInputMessage>
      expect(input).toHaveLength(2)
      expect(input[0]).toMatchObject({
        type: "message",
        role: "system",
      })
      expect(typeof input[0].content).toBe("string")
      expect(input[0].content).toContain("Review carefully.")
      expect(input[1]).toEqual({
        type: "message",
        role: "user",
        content: "First request",
      })
      if (Array.isArray(system)) {
        expect(input[0].content).toContain("Preserve details.")
      }
    },
  )

  it("preserves multiple text blocks, image blocks and strings for Grok", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "grok-4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "First block" },
            { type: "text", text: "Second block" },
          ],
        },
        {
          role: "user",
          content: [
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
        { role: "user", content: "Already a string" },
        { role: "assistant", content: [] },
      ],
    })

    expect(result).not.toHaveProperty("instructions")
    expect(result.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "First block" },
          { type: "output_text", text: "Second block" },
        ],
        phase: "final_answer",
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,image-data",
            detail: "auto",
          },
        ],
      },
      { type: "message", role: "user", content: "Already a string" },
    ])
  })

  it.each([
    { texts: ["exit  "] },
    { texts: [""] },
    { texts: ["First line", "Second line  "] },
    { texts: [] },
  ])("preserves Grok tool output text arrays for %j", ({ texts }) => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "grok-4",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_review",
              content: texts.map((text) => ({ type: "text", text })),
              is_error: true,
            },
          ],
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_review",
        output: texts.map((text) => ({ type: "input_text", text })),
        status: "incomplete",
      },
    ])
  })

  it.each([false, true])(
    "preserves Grok tool output images with text included: %j",
    (includeText) => {
      const result = translateAnthropicMessagesToResponsesPayload({
        model: "grok-4",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_image",
                content: [
                  ...(includeText ?
                    [{ type: "text" as const, text: "Image result" }]
                  : []),
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
      })

      expect(result.input).toEqual([
        {
          type: "function_call_output",
          call_id: "call_image",
          output: [
            ...(includeText ?
              [{ type: "input_text", text: "Image result" }]
            : []),
            {
              type: "input_image",
              image_url: "data:image/png;base64,image-data",
              detail: "auto",
            },
          ],
          status: "completed",
        },
      ])
    },
  )

  it.each(["gpt-5.4", "claude-3-5-sonnet"])(
    "preserves single text content arrays for %s",
    (model) => {
      const result = translateAnthropicMessagesToResponsesPayload({
        model,
        max_tokens: 1024,
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
          { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        ],
      })

      expect(result.temperature).toBe(1)
      expect(result.top_p).toBeNull()
      expect(result.max_output_tokens).toBe(12800)
      expect(result.reasoning?.summary).toBe("auto")
      expect(result.include).toEqual(["reasoning.encrypted_content"])
      expect(result.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi" }],
          phase: "final_answer",
        },
      ])
    },
  )

  it("extracts identifiers from JSON-like user_id metadata", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      metadata: {
        user_id: jsonStyleUserId,
      },
      tools: sampleTools,
    })

    expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
  })

  it.each([undefined, "agent-a", "agent-b"])(
    "shares the metadata cache key between main and subagents (%s)",
    (agentId) => {
      const result = translateAnthropicMessagesToResponsesPayload({
        ...samplePayload,
        metadata: { user_id: jsonStyleUserId },
        tools: sampleTools,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  agentId ?
                    `<system-reminder>__SUBAGENT_MARKER__${JSON.stringify({ session_id: "child", agent_id: agentId, agent_type: "Explore" })}</system-reminder>`
                  : "hello",
              },
            ],
          },
        ],
      })

      expect(result.prompt_cache_key).toBe(
        "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752",
      )
    },
  )

  it("keeps legacy user_id parsing before JSON fallback", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      metadata: {
        user_id: legacyStyleUserId,
      },
      tools: sampleTools,
    })

    expect(result.prompt_cache_key).toBe("7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b")
  })

  it("falls back to session affinity when metadata session id is empty", () => {
    const result = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () =>
        translateAnthropicMessagesToResponsesPayload({
          ...samplePayload,
          metadata: {
            user_id: emptySessionUserId,
          },
          tools: sampleTools,
        }),
    )

    expect(result.prompt_cache_key).toBe("opencode-session")
  })

  it("keeps unrelated system prompt text unchanged", () => {
    const payload = {
      model: "gpt-5.4",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: "ordinary system prompt",
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello gpt54" }],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    const result = translateAnthropicMessagesToResponsesPayload(payload)

    expect(result.instructions).toContain("ordinary system prompt")
    expect(result.instructions).not.toContain("cch=<stable>;")
  })

  it("translates inline system messages to developer items", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content: "leading system prompt",
        },
        {
          role: "user",
          content: "hello",
        },
        {
          role: "system",
          content: "late system prompt",
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: "leading system prompt",
      },
      {
        type: "message",
        role: "user",
        content: "hello",
      },
      {
        type: "message",
        role: "developer",
        content: "late system prompt",
      },
    ])
  })

  it("keeps prompt_cache_key null when no session id is provided", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      tools: sampleTools,
    })

    expect(result.prompt_cache_key).toBeNull()
  })

  it.each([{ tools: undefined }, { tools: [] }])(
    "omits prompt_cache_key when tools are %j",
    ({ tools }) => {
      const result = translateAnthropicMessagesToResponsesPayload({
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools,
      })

      expect(result).not.toHaveProperty("prompt_cache_key")
    },
  )

  it("omits tool_choice when the request has no tools", () => {
    const missingTools =
      translateAnthropicMessagesToResponsesPayload(samplePayload)
    const emptyTools = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      tools: [],
      tool_choice: { type: "any" },
    })

    expect(missingTools.tools).toBeNull()
    expect(missingTools).not.toHaveProperty("tool_choice")
    expect(emptyTools.tools).toBeNull()
    expect(emptyTools).not.toHaveProperty("tool_choice")
  })

  it("omits tool_choice when every tool is dropped in translation", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "search tools" }],
      tools: [
        {
          name: "mcp__tool_search__search",
          description: "Search deferred tools",
          input_schema: {
            type: "object",
            properties: {
              names: { type: "string" },
            },
            required: ["names"],
          },
        },
      ],
    })

    expect(result.tools).toEqual([])
    expect(result).not.toHaveProperty("tool_choice")
  })

  it.each(["grok-4", "gpt-5.4"])(
    "respects Anthropic parallel tool settings for %s",
    (model) => {
      for (const disableParallelToolUse of [true, false, undefined]) {
        const result = translateAnthropicMessagesToResponsesPayload({
          ...samplePayload,
          model,
          tools: sampleTools,
          tool_choice: {
            type: "auto",
            disable_parallel_tool_use: disableParallelToolUse,
          },
        })

        expect(result.parallel_tool_calls).toBe(!disableParallelToolUse)
      }
    },
  )

  it("keeps a translated tool_choice when the request has tools", () => {
    const defaultChoice = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      tools: sampleTools,
    })
    const namedChoice = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      tools: sampleTools,
      tool_choice: { type: "tool", name: "getWeather" },
    })
    const requiredChoice = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      tools: sampleTools,
      tool_choice: { type: "any" },
    })

    expect(defaultChoice.tools).not.toBeNull()
    expect(defaultChoice.tool_choice).toBe("auto")
    expect(namedChoice.tool_choice).toEqual({
      type: "function",
      name: "getWeather",
    })
    expect(requiredChoice.tool_choice).toBe("required")
  })

  it("maps tool_reference tool results into function_call_output text", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
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
    })

    const input = result.input as Array<ResponseFunctionCallOutputItem>
    expect(input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "Tool AskUserQuestion loaded",
          },
        ],
        status: "completed",
      },
    ])
  })

  it("maps document tool results into function_call_output input_file content", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
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
    })

    const input = result.input as Array<ResponseFunctionCallOutputItem>
    expect(input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_file",
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,pdf-data",
          },
        ],
        status: "completed",
      },
    ])
  })

  it("converts bridge and deferred tools into Responses tool_search and namespaces", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fetch a page" }],
      tools: [
        {
          name: "mcp__tool_search__search",
          description: "Search deferred tools",
          input_schema: {
            type: "object",
            properties: {
              names: { type: "string" },
            },
            required: ["names"],
          },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
            required: ["url"],
          },
        },
        {
          name: "chrome-devtools_click",
          description: "Click an element",
          input_schema: {
            type: "object",
            properties: {
              uid: { type: "string" },
            },
            required: ["uid"],
          },
        },
        {
          name: "Read",
          description: "Read a file",
          strict: true,
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
            required: ["file_path"],
          },
        },
      ],
    })

    expect(result.parallel_tool_calls).toBe(true)
    expect(result.tools).toEqual([
      {
        type: "tool_search",
        execution: "client",
        description:
          "Load deferred tools by exact name before using them. Return only the searchable tool names you need for the next step.",
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              description: "Exact deferred tool names to load.",
              items: {
                type: "string",
                enum: ["mcp__fetch__fetch", "chrome-devtools_click"],
              },
              minItems: 1,
            },
          },
          required: ["names"],
          additionalProperties: false,
        },
      },
      {
        type: "namespace",
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        tools: [
          {
            type: "function",
            name: "mcp__fetch__fetch",
            description: "Fetch a URL",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
              required: ["url"],
            },
            strict: false,
            defer_loading: true,
          },
        ],
      },
      {
        type: "namespace",
        name: "chrome-devtools_click",
        description: "Click an element",
        tools: [
          {
            type: "function",
            name: "chrome-devtools_click",
            description: "Click an element",
            parameters: {
              type: "object",
              properties: {
                uid: { type: "string" },
              },
              required: ["uid"],
            },
            strict: false,
            defer_loading: true,
          },
        ],
      },
      {
        type: "function",
        name: "Read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
        strict: true,
      },
    ])
  })

  it("keeps deferred candidates as normal functions when the bridge tool is absent", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fetch a page" }],
      tools: [
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
          },
        },
        {
          name: "chrome-devtools_click",
          description: "Click an element",
          input_schema: {
            type: "object",
            properties: {
              uid: { type: "string" },
            },
          },
        },
      ],
    })

    expect(result.parallel_tool_calls).toBe(true)
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
        },
        strict: false,
      },
      {
        type: "function",
        name: "chrome-devtools_click",
        description: "Click an element",
        parameters: {
          type: "object",
          properties: {
            uid: { type: "string" },
          },
        },
        strict: false,
      },
    ])
  })

  it.each(["mcp__tool_search__search", "tool_search_search"])(
    "maps %s tool_use history into tool_search_call input items",
    (bridgeName) => {
      const result = translateAnthropicMessagesToResponsesPayload({
        model: "gpt-5.4",
        max_tokens: 1024,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_search",
                name: bridgeName,
                input: { names: "mcp__fetch__fetch" },
              },
            ],
          },
        ],
        tools: [
          {
            name: bridgeName,
            input_schema: { type: "object" },
          },
          {
            name: "mcp__fetch__fetch",
            input_schema: { type: "object" },
          },
        ],
      })

      const input = result.input as Array<ResponseToolSearchCallItem>
      expect(input).toEqual([
        {
          type: "tool_search_call",
          call_id: "call_search",
          arguments: { names: ["mcp__fetch__fetch"] },
          execution: "client",
          status: "completed",
        },
      ])
    },
  )

  it("preserves namespace on deferred tool_use history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_shipping_eta",
              name: "get_shipping_eta",
              input: { order_id: "order_42" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "get_shipping_eta",
          input_schema: { type: "object" },
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "function_call",
        call_id: "call_shipping_eta",
        name: "get_shipping_eta",
        namespace: "get_shipping_eta",
        arguments: '{"order_id":"order_42"}',
        status: "completed",
      },
    ])
  })

  it("rebuilds tool_search_output from tool_reference history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "mcp__fetch__fetch" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_search",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "mcp__fetch__fetch",
                },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
          },
        },
      ],
    })

    const input = result.input as Array<
      ResponseToolSearchCallItem | ResponseToolSearchOutputItem
    >
    expect(input[1]).toEqual({
      type: "tool_search_output",
      call_id: "call_search",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          tools: [
            {
              type: "function",
              name: "mcp__fetch__fetch",
              description: "Fetch a URL",
              parameters: {
                type: "object",
                properties: {
                  url: { type: "string" },
                },
              },
              strict: false,
              defer_loading: true,
            },
          ],
        },
      ],
      status: "completed",
    })
  })

  it("rebuilds tool_search_output from bridge sentinel results", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "TaskList" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_search",
              content: createMcpToolSearchSentinel("TaskList"),
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: { type: "object" },
        },
        {
          name: "TaskList",
          description: "List tasks",
          input_schema: { type: "object" },
        },
      ],
    })

    const input = result.input as Array<
      ResponseToolSearchCallItem | ResponseToolSearchOutputItem
    >
    const output = input[1] as ResponseToolSearchOutputItem
    expect(output.type).toBe("tool_search_output")
    expect(output.execution).toBe("client")
    expect(
      (output.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["TaskList"])
  })
})

describe("translateResponsesResultToAnthropic", () => {
  it("handles reasoning and function call items", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_123",
      object: "response",
      created_at: 0,
      model: "gpt-4.1",
      output: [
        {
          id: "reason_1",
          type: "reasoning",
          summary: [
            {
              type: "summary_text",
              text: "**Thinking about the task**\n\nReviewing the request.",
            },
            { type: "summary_text", text: "**Preparing the tool call**" },
          ],
          status: "completed",
          encrypted_content: "encrypted_reasoning_content",
        },
        {
          id: "call_1",
          type: "function_call",
          call_id: "call_1",
          name: "TodoWrite",
          arguments:
            '{"todos":[{"content":"Read src/routes/responses/translation.ts","status":"in_progress"}]}',
          status: "completed",
        },
        {
          id: "message_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Added the task to your todo list.",
              annotations: [],
            },
          ],
        },
      ],
      output_text: "Added the task to your todo list.",
      status: "incomplete",
      usage: {
        input_tokens: 120,
        output_tokens: 36,
        total_tokens: 156,
      },
      error: null,
      incomplete_details: { reason: "content_filter" },
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.content).toHaveLength(3)

    const [thinkingBlock, toolUseBlock, textBlock] = anthropicResponse.content

    expect(thinkingBlock.type).toBe("thinking")
    if (thinkingBlock.type === "thinking") {
      expect(thinkingBlock.thinking).toBe(
        "**Thinking about the task**\n\nReviewing the request."
          + REASONING_SUMMARY_SEPARATOR
          + "**Preparing the tool call**",
      )
    }

    expect(toolUseBlock.type).toBe("tool_use")
    if (toolUseBlock.type === "tool_use") {
      expect(toolUseBlock.id).toBe("call_1")
      expect(toolUseBlock.name).toBe("TodoWrite")
      expect(toolUseBlock.input).toEqual({
        todos: [
          {
            content: "Read src/routes/responses/translation.ts",
            status: "in_progress",
          },
        ],
      })
    }

    expect(textBlock.type).toBe("text")
    if (textBlock.type === "text") {
      expect(textBlock.text).toBe("Added the task to your todo list.")
    }
  })

  it("uses function_call namespace as the Anthropic tool_use name", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_namespace",
      object: "response",
      created_at: 0,
      model: "gpt-5.4",
      output: [
        {
          id: "call_1",
          type: "function_call",
          call_id: "call_1",
          name: "invoke",
          namespace: "mcp__fetch__fetch",
          arguments: '{"url":"https://example.com"}',
          status: "completed",
        },
      ],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "mcp__fetch__fetch",
        input: {
          url: "https://example.com",
        },
      },
    ])
  })

  it("maps tool_search_call output into the bridge Anthropic tool_use", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_search",
      object: "response",
      created_at: 0,
      model: "gpt-5.4",
      output: [
        {
          id: "search_1",
          type: "tool_search_call",
          call_id: "call_search",
          arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
          status: "completed",
        },
      ],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content).toEqual([
      {
        type: "tool_use",
        id: "call_search",
        name: "mcp__tool_search__search",
        input: {
          names: "mcp__fetch__fetch,TaskList",
        },
      },
    ])
  })
})
