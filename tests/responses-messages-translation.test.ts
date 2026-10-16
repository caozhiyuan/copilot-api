import { describe, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
} from "~/lib/types/anthropic"
import type {
  ResponsesPayload,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import { requestContext } from "~/lib/request-context"
import {
  buildOutputFormatInstruction,
  createMessagesBackedResponsesResult,
  decodeMessagesCompaction,
  encodeMessagesCompaction,
  MESSAGES_COMPACTION_PREFIX,
  MESSAGES_TOOL_CALL_TIPS,
  ResponsesMessagesTranslationError,
  translateAnthropicToResponses,
  translateResponsesToMessages,
} from "~/routes/responses/messages-translation"
import {
  responsesResultToStreamEvents,
  translateMessagesStream,
} from "~/routes/responses/messages-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

const translate = (
  payload: Omit<ResponsesPayload, "model">,
  options?: { toolCallTips?: boolean },
) =>
  translateResponsesToMessages(
    { model: "claude-sonnet-4.6", ...payload },
    { model: "claude-sonnet-4.6", ...options },
  )

const translateWithTips = (payload: Omit<ResponsesPayload, "model">) =>
  translate(payload, { toolCallTips: true })

const trailingUserMessageText = (
  translation: ReturnType<typeof translate>,
): string => {
  const lastMessage = translation.messagesPayload.messages.at(-1)
  expect(lastMessage?.role).toBe("user")
  if (!lastMessage || !Array.isArray(lastMessage.content)) {
    throw new Error("Expected the trailing message to carry block content")
  }
  return lastMessage.content
    .map((block) => ("text" in block ? block.text : ""))
    .join("")
}

const expectCanonicalBase64 = (value: string | undefined) => {
  expect(value).toBeTruthy()
  if (!value) return
  expect(Buffer.from(value, "base64").toString("base64")).toBe(value)
}

describe("Responses Lite to Messages translation", () => {
  test("includes yielded execution resume guidance in tool call tips", () => {
    expect(MESSAGES_TOOL_CALL_TIPS).toContain(
      "- Yielded execution is not truncated output. Resume a running `cell_id` with `functions.wait` (tool name: `wait`), and a live `session_id` with `tools.write_stdin`, until the command reaches a terminal result.",
    )
  })

  test("includes aborted exec retry guidance in tool call tips", () => {
    expect(MESSAGES_TOOL_CALL_TIPS).toContain(
      "- If `functions.exec` returns `aborted`, retry at most 3 times. After 3 failures, terminate immediately and inform the user that `functions.exec` is unavailable.",
    )
  })

  test("prefers request session affinity for metadata user id", () => {
    const result = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: " request-session ",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () =>
        translate({
          input: "Hello",
          metadata: { user_id: "metadata-user" },
          prompt_cache_key: "prompt-cache-user",
          safety_identifier: "safety-user",
        }),
    )

    expect(result.messagesPayload.metadata).toEqual({
      user_id: "request-session",
    })
  })

  test("ignores blank session affinity and preserves payload fallbacks", () => {
    const results = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "   ",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () => [
        translate({
          input: "Hello",
          metadata: { user_id: "metadata-user" },
          prompt_cache_key: "prompt-cache-user",
          safety_identifier: "safety-user",
        }),
        translate({
          input: "Hello",
          metadata: { user_id: "   " },
          prompt_cache_key: "prompt-cache-user",
          safety_identifier: "safety-user",
        }),
        translate({
          input: "Hello",
          prompt_cache_key: "prompt-cache-user",
          safety_identifier: "   ",
        }),
        translate({ input: "Hello" }),
      ],
    )

    expect(results.map((result) => result.messagesPayload.metadata)).toEqual([
      { user_id: "metadata-user" },
      { user_id: "safety-user" },
      { user_id: "prompt-cache-user" },
      undefined,
    ])
  })

  test("groups the first five developer prompts into two system blocks", () => {
    const result = translateWithTips({
      instructions: "Base instructions",
      input: [
        { role: "developer", content: "Developer one", type: "message" },
        {
          role: "developer",
          content: [
            { type: "input_text", text: "Developer two, part one" },
            { type: "input_text", text: "Developer two, part two" },
          ],
          type: "message",
        },
        { role: "developer", content: "Developer three", type: "message" },
        { role: "developer", content: "Developer four", type: "message" },
        { role: "developer", content: "Developer five", type: "message" },
        { role: "developer", content: "Developer six", type: "message" },
        { role: "user", content: "First user message", type: "message" },
        { role: "user", content: "Second user message", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      { type: "text", text: "Base instructions" },
      { type: "text", text: "Developer one" },
      {
        type: "text",
        text:
          [
            "Developer two, part one",
            "Developer two, part two",
            "Developer three",
            "Developer four",
            "Developer five",
          ].join("\n\n")
          + "\n\n"
          + MESSAGES_TOOL_CALL_TIPS,
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "First user message" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Second user message",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("adds ephemeral cache_control to the last system block and the tail block of the last user message", () => {
    const result = translateWithTips({
      instructions: "Base instructions",
      input: [
        { role: "user", content: "First user message", type: "message" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Second user, part one" },
            { type: "input_text", text: "Second user, part two" },
          ],
          type: "message",
        },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      {
        type: "text",
        text: `Base instructions\n\n${MESSAGES_TOOL_CALL_TIPS}`,
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "First user message" },
      {
        role: "user",
        content: [
          { type: "text", text: "Second user, part one" },
          {
            type: "text",
            text: "Second user, part two",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("appends tool call tips to string input when enabled", () => {
    const result = translate(
      { instructions: "Base instructions", input: "Hello" },
      { toolCallTips: true },
    )

    expect(result.messagesPayload.system).toEqual([
      {
        type: "text",
        text: `Base instructions\n\n${MESSAGES_TOOL_CALL_TIPS}`,
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  test.each([undefined, "Base instructions"])(
    "adds Promise.allSettled guidance when parallel tool calls are disabled with instructions %j",
    (instructions) => {
      const result = translateWithTips({
        instructions,
        input: "Hello",
        parallel_tool_calls: false,
      })

      expect(Array.isArray(result.messagesPayload.system)).toBe(true)
      const system = result.messagesPayload.system as Array<AnthropicTextBlock>
      expect(system).toHaveLength(1)
      expect(system[0].text).toContain(MESSAGES_TOOL_CALL_TIPS)
      expect(system[0].text).toContain(
        "Parallel tool calls are disabled for this request.",
      )
      expect(system[0].text).toContain(
        'await Promise.allSettled([tools.exec_command({cmd: "git status --short"})])',
      )
      expect(system[0].text).toContain(
        "]); for (const result of results) text(",
      )
      expect(system[0].text).toContain('result.status === "fulfilled"')
      expect(system[0].text).toContain("{error: String(result.reason)}")
      expect(system[0].text).toContain("text(JSON.stringify(result.status")
      expect(system[0].text).not.toContain("```")
      expect(system[0]).toHaveProperty("cache_control", { type: "ephemeral" })
      if (instructions) expect(system[0].text).toContain(instructions)
    },
  )

  test.each([true, undefined, null])(
    "omits Promise.allSettled guidance for parallel_tool_calls %j",
    (parallelToolCalls) => {
      const result = translateWithTips({
        input: "Hello",
        parallel_tool_calls: parallelToolCalls,
      })

      expect(result.messagesPayload.system).toEqual([
        {
          type: "text",
          text: MESSAGES_TOOL_CALL_TIPS,
          cache_control: { type: "ephemeral" },
        },
      ])
    },
  )

  test("omits batching guidance when tool call tips are disabled", () => {
    const result = translate({ input: "Hello", parallel_tool_calls: false })

    expect(result.messagesPayload.system).toBeUndefined()
  })

  test("omits tool call tips unless enabled", () => {
    const result = translate({
      instructions: "Base instructions",
      input: [{ role: "user", content: "Hello", type: "message" }],
    })

    expect(result.messagesPayload.system).toEqual([
      {
        type: "text",
        text: "Base instructions",
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("adds a dedicated system block for tool call tips when no prompt exists", () => {
    const result = translate(
      { input: [{ role: "user", content: "Hello", type: "message" }] },
      { toolCallTips: true },
    )

    expect(result.messagesPayload.system).toEqual([
      {
        type: "text",
        text: MESSAGES_TOOL_CALL_TIPS,
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("leaves a trailing empty content array without cache_control", () => {
    const result = translate({
      input: [{ role: "user", content: [], type: "message" }],
    })

    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: [] },
    ])
  })

  test("marks the final user message even when a thinking block trails", () => {
    const result = translate({
      input: [
        { role: "user", content: "What is 2 + 2?", type: "message" },
        {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Calculate the sum." }],
          encrypted_content: "reasoning-signature",
        },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "What is 2 + 2?",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Calculate the sum.",
            signature: "reasoning-signature",
          },
        ],
      },
    ])
    const lastMessage = result.messagesPayload.messages.at(-1)
    if (!lastMessage || !Array.isArray(lastMessage.content)) {
      throw new Error("Expected the trailing message to carry block content")
    }
    expect(lastMessage.content.at(-1)).not.toHaveProperty("cache_control")
  })

  test("converts developer messages after the first user to user messages", () => {
    const result = translateWithTips({
      input: [
        { role: "developer", content: "Initial developer", type: "message" },
        { role: "user", content: "First user message", type: "message" },
        { role: "developer", content: "Later developer", type: "message" },
        {
          role: "developer",
          content: [
            { type: "input_text", text: "Later developer, part one" },
            { type: "input_text", text: "Later developer, part two" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
              detail: "auto",
            },
          ],
          type: "message",
        },
        { role: "user", content: "Second user message", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      {
        type: "text",
        text: `Initial developer\n\n${MESSAGES_TOOL_CALL_TIPS}`,
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "First user message" },
      { role: "user", content: "Later developer" },
      {
        role: "user",
        content: [
          { type: "text", text: "Later developer, part one" },
          { type: "text", text: "Later developer, part two" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Second user message",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("translates agent messages and later developer messages to user", () => {
    const result = translateWithTips({
      input: [
        { role: "developer", content: "Initial developer", type: "message" },
        {
          id: "amsg-1",
          type: "agent_message",
          author: "agent-a",
          recipient: "agent-b",
          content: [
            { type: "input_text", text: "Agent handoff" },
            {
              type: "encrypted_content",
              encrypted_content: "encrypted-handoff",
            },
          ],
        },
        { role: "developer", content: "Later developer", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      {
        type: "text",
        text: `Initial developer\n\n${MESSAGES_TOOL_CALL_TIPS}`,
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Agent handoff" },
          { type: "text", text: "encrypted-handoff" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Later developer",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("keeps initial developer prompts when replaying a compaction", () => {
    const result = translateWithTips({
      input: [
        { role: "developer", content: "Developer one", type: "message" },
        { role: "developer", content: "Developer two", type: "message" },
        {
          id: "cmp-1",
          type: "compaction",
          encrypted_content: encodeMessagesCompaction("Existing handoff"),
        },
        { role: "user", content: "Continue", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      { type: "text", text: "Developer one" },
      {
        type: "text",
        text: `Developer two\n\n${MESSAGES_TOOL_CALL_TIPS}`,
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content:
          "The previous conversation was compacted. Continue from this handoff summary:\n\nExisting handoff",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Continue",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("encodes compaction content as canonical Base64", () => {
    const summary = "Existing handoff"
    const encoded = encodeMessagesCompaction(summary)
    const legacy = `${MESSAGES_COMPACTION_PREFIX}${Buffer.from(summary, "utf8").toString("base64url")}`

    expectCanonicalBase64(encoded)
    expect(decodeMessagesCompaction(encoded)).toBe(summary)
    expect(decodeMessagesCompaction(legacy)).toBe(summary)
    expect(decodeMessagesCompaction("not base64")).toBeNull()
  })

  test("removes built-in web search while preserving other top-level tools", () => {
    const tools: NonNullable<ResponsesPayload["tools"]> = [
      { type: "function", name: "web_search", parameters: null, strict: null },
      { type: "custom", name: "apply_patch" },
      {
        type: "namespace",
        name: "web_search",
        tools: [
          { type: "function", name: "run", parameters: null, strict: null },
        ],
      },
    ]
    const result = translate({
      input: "Hello",
      tools: [{ type: "web_search" }, ...tools],
    })

    expect(result.originalPayload.tools).toEqual(tools)
    expect(result.messagesPayload.tools?.map((tool) => tool.name)).toEqual([
      "web_search",
      "apply_patch",
      "web_search__run",
    ])
  })

  test("omits Messages tools and tool choice after removing the only tool", () => {
    const result = translate({
      input: "Hello",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    })

    expect(result.originalPayload.tools).toEqual([])
    expect(result.originalPayload.tool_choice).toBe("required")
    expect(result.messagesPayload.tools).toBeUndefined()
    expect(result.messagesPayload.tool_choice).toBeUndefined()
  })

  test("still rejects web search tools in input.additional_tools", () => {
    const payload: ResponsesPayload = {
      model: "claude-sonnet-4.6",
      input: [
        {
          role: "developer",
          type: "additional_tools",
          tools: [{ type: "web_search" }],
        },
        { role: "user", type: "message", content: "Hello" },
      ],
      tools: [{ type: "web_search" }],
    }
    const originalInput = structuredClone(payload.input)

    expect(() =>
      translateResponsesToMessages(payload, { model: payload.model }),
    ).toThrow("does not support tool 'web_search'")
    expect(payload.tools).toEqual([])
    expect(payload.input).toEqual(originalInput)
  })

  test("omits tool_choice without registered tools and preserves the request", () => {
    const choices: Array<NonNullable<ResponsesPayload["tool_choice"]>> = [
      "auto",
      "none",
      "required",
      { type: "function", name: "getWeather" },
      { type: "custom", name: "apply_patch" },
    ]

    for (const tools of [undefined, null, []]) {
      for (const toolChoice of choices) {
        const payload: ResponsesPayload = {
          model: "claude-sonnet-4.6",
          input: "Hello",
          tools,
          tool_choice: toolChoice,
        }
        const result = translateResponsesToMessages(payload, {
          model: payload.model,
        })

        expect(result.messagesPayload.tools).toBeUndefined()
        expect(result.messagesPayload.tool_choice).toBeUndefined()
        expect(
          JSON.parse(JSON.stringify(result.messagesPayload)),
        ).not.toHaveProperty("tool_choice")
        expect(payload.tool_choice).toEqual(toolChoice)
        expect(result.originalPayload.tool_choice).toEqual(toolChoice)
      }
    }
  })

  test("preserves the original tool choice in Responses results without tools", () => {
    const translation = translate({ input: "Hello", tool_choice: "none" })
    const result = createMessagesBackedResponsesResult({
      context: translation,
      id: "resp_no_tools",
      output: [],
      outputText: "",
      status: "completed",
    })

    expect(result.tool_choice).toBe("none")
  })

  test.each([false, true])(
    "preserves parallel_tool_calls %j through serialized Messages requests",
    (parallelToolCalls) => {
      for (const toolChoice of [
        undefined,
        "auto",
        "required",
        { type: "function", name: "getWeather" },
        { type: "custom", name: "apply_patch" },
      ] as const) {
        const translation = translate({
          input: "Check the weather",
          tools: [
            { type: "function", name: "getWeather", parameters: null },
            { type: "custom", name: "apply_patch" },
          ],
          tool_choice: toolChoice,
          parallel_tool_calls: parallelToolCalls,
        })
        const messagesPayload = JSON.parse(
          JSON.stringify(translation.messagesPayload),
        ) as AnthropicMessagesPayload

        expect(messagesPayload.tool_choice?.disable_parallel_tool_use).toBe(
          !parallelToolCalls,
        )
        if (toolChoice && typeof toolChoice === "object") {
          expect(messagesPayload.tool_choice?.name).toBe(toolChoice.name)
        } else {
          expect(messagesPayload.tool_choice?.type).toBe(
            toolChoice === "required" ? "any" : "auto",
          )
        }
        expect(
          translateAnthropicMessagesToResponsesPayload(messagesPayload)
            .parallel_tool_calls,
        ).toBe(parallelToolCalls)
      }
    },
  )

  test.each([undefined, null])(
    "leaves the default parallel tool behavior unchanged for %j",
    (parallelToolCalls) => {
      const translation = translate({
        input: "Check the weather",
        tools: [{ type: "function", name: "getWeather", parameters: null }],
        parallel_tool_calls: parallelToolCalls,
      })

      expect(translation.messagesPayload.tool_choice).toBeUndefined()
      expect(
        translateAnthropicMessagesToResponsesPayload(
          translation.messagesPayload,
        ).parallel_tool_calls,
      ).toBe(true)
    },
  )

  test("does not add parallel tool settings when tools cannot be called", () => {
    const withoutTools = translate({
      input: "Hello",
      parallel_tool_calls: false,
    })
    const withoutToolUse = translate({
      input: "Hello",
      tools: [{ type: "function", name: "getWeather", parameters: null }],
      tool_choice: "none",
      parallel_tool_calls: false,
    })

    expect(withoutTools.messagesPayload.tool_choice).toBeUndefined()
    expect(withoutToolUse.messagesPayload.tool_choice).toEqual({ type: "none" })
  })

  test.each([false, true])(
    "preserves parallel_tool_calls %j through Chat Completions translation",
    (parallelToolCalls) => {
      const translation = translate({
        input: "Check the weather",
        tools: [{ type: "function", name: "getWeather", parameters: null }],
        parallel_tool_calls: parallelToolCalls,
      })
      const openAIPayload = translateToOpenAI(translation.messagesPayload)

      expect(openAIPayload.parallel_tool_calls).toBe(parallelToolCalls)
      expect(Object.hasOwn(openAIPayload, "parallel_tool_calls")).toBe(true)
    },
  )

  test("keeps named tool choices for top-level tools", () => {
    const result = translate({
      input: "Check the weather",
      tools: [{ type: "function", name: "getWeather", parameters: null }],
      tool_choice: { type: "function", name: "getWeather" },
    })

    expect(result.messagesPayload.tool_choice).toEqual({
      type: "tool",
      name: "getWeather",
    })
  })

  test("keeps required and disabled choices for input tools with empty top-level tools", () => {
    for (const toolChoice of ["required", "none"] as const) {
      const result = translate({
        input: [
          {
            role: "developer",
            type: "additional_tools",
            tools: [{ type: "custom", name: "apply_patch" }],
          },
          { role: "user", content: "Update the file", type: "message" },
        ],
        tools: [],
        tool_choice: toolChoice,
      })

      expect(result.messagesPayload.tools?.[0]?.name).toBe("apply_patch")
      expect(result.messagesPayload.tool_choice).toEqual({
        type: toolChoice === "required" ? "any" : "none",
      })
    }
  })

  test.each([
    { model: "claude-sonnet-4.6", strict: false },
    { model: "claude-opus-4-6", strict: false },
    { model: "anthropic/claude-sonnet-4.6", strict: false },
    { model: "custom/vendor-Claude-model", strict: false },
    { model: "glm-5.3-flash", strict: true },
    { model: "custom/glm-5.3-flash", strict: true },
    { model: "claude-relay/glm-5.3-flash", strict: true },
  ])("sets custom tool strictness for target $model", ({ model, strict }) => {
    const result = translateResponsesToMessages(
      {
        model: strict ? "claude-sonnet-4.6" : "public-alias",
        input: [
          {
            role: "developer",
            type: "additional_tools",
            tools: [
              { type: "custom", name: "input_patch" },
              {
                type: "namespace",
                name: "input_tools",
                tools: [{ type: "custom", name: "apply_patch" }],
              },
            ],
          },
          { role: "user", type: "message", content: "Update the file" },
        ],
        tools: [
          { type: "custom", name: "apply_patch" },
          {
            type: "namespace",
            name: "workspace",
            tools: [
              {
                type: "namespace",
                name: "files",
                tools: [{ type: "custom", name: "apply_patch" }],
              },
            ],
          },
          { type: "function", name: "getWeather", parameters: null },
        ],
      },
      { model },
    )
    const tools = result.messagesPayload.tools

    expect(tools?.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "workspace_files__apply_patch",
      "getWeather",
      "input_patch",
      "input_tools__apply_patch",
    ])
    for (const tool of tools ?? []) {
      if (strict && tool.name !== "getWeather") {
        expect(tool).toHaveProperty("strict", true)
      } else {
        expect(tool).not.toHaveProperty("strict")
      }
    }
  })

  test("loads custom tools from input.additional_tools", () => {
    const result = translate({
      input: [
        {
          id: "tools-1",
          role: "developer",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply a patch to workspace files",
              format: { type: "text" },
            },
          ],
          type: "additional_tools",
        },
        { role: "user", content: "Update the file", type: "message" },
      ],
      tool_choice: { type: "custom", name: "apply_patch" },
    })

    expect(result.messagesPayload.tools).toEqual([
      {
        name: "apply_patch",
        description: "Apply a patch to workspace files",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    ])
    expect(result.messagesPayload.tool_choice).toEqual({
      type: "tool",
      name: "apply_patch",
    })
    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Update the file",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test.each([undefined, null, ""])(
    "reuses default tool aliases for historical namespace %j",
    (namespace) => {
      for (const collision of [false, true]) {
        const result = translate({
          tools:
            collision ?
              [{ type: "function", name: "exec", parameters: null }]
            : [],
          input: [
            {
              type: "additional_tools",
              role: "developer",
              tools: [
                {
                  type: "namespace",
                  name: "functions",
                  tools: [{ type: "custom", name: "exec" }],
                },
                {
                  type: "namespace",
                  name: "sandbox",
                  tools: [{ type: "custom", name: "exec" }],
                },
              ],
            },
            { role: "user", content: "Run it" },
            {
              type: "custom_tool_call",
              call_id: "call-exec",
              name: "exec",
              namespace,
              input: "text(1)",
            },
            {
              type: "custom_tool_call_output",
              call_id: "call-exec",
              output: "1",
            },
          ],
          tool_choice: { type: "custom", name: "exec" },
        })
        const alias = result.messagesPayload.tools?.at(-2)?.name
        if (collision) expect(alias).toMatch(/^tool_/u)
        else expect(alias).toBe("exec")
        expect(result.messagesPayload.tools?.at(-1)?.name).toBe("sandbox__exec")
        expect(result.messagesPayload.messages[1]).toMatchObject({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-exec",
              name: alias,
              input: { input: "text(1)" },
            },
          ],
        })
        expect(result.messagesPayload.tool_choice).toEqual({
          type: "tool",
          name: alias,
        })
      }
    },
  )

  test("does not infer a non-default namespace from bare tool history or choice", () => {
    const payload = {
      tools: [
        {
          type: "namespace",
          name: "sandbox",
          tools: [{ type: "custom", name: "exec" }],
        },
      ],
      input: [
        {
          type: "custom_tool_call",
          call_id: "call-exec",
          name: "exec",
          input: "text(1)",
        },
      ],
    }
    const result = translate(payload)
    expect(result.messagesPayload.tools?.map((tool) => tool.name)).toEqual([
      "sandbox__exec",
    ])
    expect(result.messagesPayload.messages[0]).toMatchObject({
      content: [{ name: "exec" }],
    })
    expect(() =>
      translate({ ...payload, tool_choice: { type: "custom", name: "exec" } }),
    ).toThrow("tool_choice references unknown")
  })

  test("does not synthesize tools from undeclared tool call history", () => {
    const result = translate({
      input: [
        {
          type: "function_call",
          call_id: "call_00_ET_DM1gjjhO7owedlK9BQF94440",
          name: "functions__view_image",
          arguments: JSON.stringify({
            path: "D:\\bud\\copilot-api\\docs\\screenshots\\desktop-dashboard.png",
          }),
          status: "completed",
        },
      ],
    })

    expect(result.registry.tools).toEqual([])
    expect(result.messagesPayload.tools).toBeUndefined()
    expect(result.messagesPayload.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_00_ET_DM1gjjhO7owedlK9BQF94440",
            name: "functions__view_image",
            input: {
              path: "D:\\bud\\copilot-api\\docs\\screenshots\\desktop-dashboard.png",
            },
          },
        ],
      },
    ])
  })

  test("marks the last user message when the conversation ends with an assistant tool call", () => {
    const result = translate({
      input: [
        { role: "user", content: "Show the dashboard", type: "message" },
        {
          type: "function_call",
          call_id: "call_00_ET_DM1gjjhO7owedlK9BQF94440",
          name: "functions__view_image",
          arguments: JSON.stringify({ path: "dashboard.png" }),
          status: "completed",
        },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Show the dashboard",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_00_ET_DM1gjjhO7owedlK9BQF94440",
            name: "functions__view_image",
            input: { path: "dashboard.png" },
          },
        ],
      },
    ])
  })

  test("merges input reasoning with the following assistant message", () => {
    const result = translate({
      input: [
        { role: "user", content: "What is 2 + 2?", type: "message" },
        {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Calculate the sum." }],
          encrypted_content: "reasoning-signature",
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "4" }],
          type: "message",
        },
        { role: "user", content: "Thanks", type: "message" },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "What is 2 + 2?" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Calculate the sum.",
            signature: "reasoning-signature",
          },
          { type: "text", text: "4" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Thanks",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("keeps an empty thinking text for reasoning items without a summary", () => {
    const result = translate({
      input: [
        { role: "user", content: "What is 2 + 2?", type: "message" },
        {
          id: "reasoning-1",
          type: "reasoning",
          summary: [],
          encrypted_content: "reasoning-signature",
        },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "What is 2 + 2?",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "",
            signature: "reasoning-signature",
          },
        ],
      },
    ])
  })

  test("restores namespace on Responses function calls", () => {
    const translation = translate({
      input: [
        {
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "workspace",
              tools: [
                {
                  type: "function",
                  name: "read_file",
                  description: "Read a workspace file",
                  parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                  },
                  strict: false,
                },
              ],
            },
          ],
          type: "additional_tools",
        },
        { role: "user", content: "Read the file", type: "message" },
      ],
    })
    expect(translation.messagesPayload.tools?.[0]?.name).toBe(
      "workspace__read_file",
    )

    const response: AnthropicResponse = {
      content: [
        {
          type: "tool_use",
          id: "call-read",
          name: "workspace__read_file",
          input: { path: "README.md" },
        },
      ],
      id: "msg_namespace",
      model: "claude-sonnet-4.6",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 8, output_tokens: 3 },
    }

    const result = translateAnthropicToResponses(response, translation)
    expect(result.output[0]).toMatchObject({
      type: "function_call",
      call_id: "call-read",
      name: "read_file",
      namespace: "workspace",
      arguments: JSON.stringify({ path: "README.md" }),
    })
  })

  test("drops empty text parts from custom tool call outputs", () => {
    const result = translate({
      input: [
        {
          type: "custom_tool_call_output",
          call_id: "call_50129f9955894d1790d490b0",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 1.3 seconds\nOutput:\n",
            },
            { type: "input_text", text: "" },
          ],
        },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_50129f9955894d1790d490b0",
            content: [
              {
                type: "text",
                text: "Script completed\nWall time 1.3 seconds\nOutput:\n",
              },
            ],
            is_error: false,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("falls back to empty text when tool call output parts are all empty", () => {
    const result = translate({
      input: [
        {
          type: "function_call_output",
          call_id: "call-empty",
          output: [{ type: "input_text", text: "" }],
        },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-empty",
            content: "",
            is_error: false,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("keeps input tools when a compaction request trims older input", () => {
    const result = translate({
      input: [
        {
          role: "developer",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply a patch",
            },
          ],
          type: "additional_tools",
        },
        {
          id: "cmp-1",
          type: "compaction",
          encrypted_content: encodeMessagesCompaction("Existing handoff"),
        },
        { role: "user", content: "Continue", type: "message" },
        { type: "compaction_trigger" },
      ],
      tool_choice: "auto",
    })

    expect(result.compaction).toBe(true)
    expect(result.messagesPayload.tools).toEqual([
      {
        name: "apply_patch",
        description: "Apply a patch",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    ])
    expect(result.messagesPayload.tool_choice).toEqual({ type: "auto" })
  })

  test("uses the Codex local handoff prompt for compaction requests", () => {
    const expectedPrompt = [
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
      "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
    ].join("\n")

    const result = translate({
      input: [
        { role: "user", content: "Implement the feature", type: "message" },
        { type: "compaction_trigger" },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "Implement the feature" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expectedPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
  })

  test("does not support Responses tool search mode", () => {
    expect(() =>
      translate({
        input: [
          {
            type: "tool_search_output",
            call_id: "search-1",
            tools: [{ type: "function", name: "hidden", parameters: null }],
          },
          { role: "user", content: "Continue", type: "message" },
        ],
      }),
    ).toThrow(ResponsesMessagesTranslationError)

    expect(() =>
      translate({
        input: "hello",
        tools: [{ type: "tool_search", execution: "client" }],
      }),
    ).toThrow("does not support tool 'tool_search'")

    expect(() =>
      translate({
        input: "hello",
        tools: [{ type: "apply_patch", name: "apply_patch" }],
      }),
    ).toThrow("does not support tool 'apply_patch'")
  })

  test("maps only valid Anthropic effort levels", () => {
    expect(
      translate({ input: "hello", reasoning: { effort: "minimal" } })
        .messagesPayload.output_config,
    ).toEqual({ effort: "low" })
    expect(
      translate({ input: "hello", reasoning: { effort: "none" } })
        .messagesPayload.output_config,
    ).toBeUndefined()
    expect(
      translate({ input: "hello", reasoning: { effort: "max" } })
        .messagesPayload.output_config,
    ).toEqual({ effort: "max" })
  })

  test("appends a JSON schema instruction as the trailing user message", () => {
    const translation = translate({
      input: [{ role: "user", content: "Give me a title", type: "message" }],
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1, maxLength: 36 },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    })

    const text = trailingUserMessageText(translation)
    expect(text).toContain('"codex_output_schema"')
    expect(text).toContain('"minLength": 1')
    expect(text).toContain("Do not wrap the JSON")
    expect(text).not.toContain("Do not call any tools")
  })

  test("preserves tool_choice for schema output with registered tools", () => {
    for (const toolChoice of ["auto", "required"] as const) {
      const translation = translate({
        input: [{ role: "user", content: "Give me a title", type: "message" }],
        tools: [{ type: "function", name: "getWeather", parameters: null }],
        tool_choice: toolChoice,
        text: {
          format: {
            type: "json_schema",
            name: "codex_output_schema",
            strict: true,
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
      })

      expect(translation.messagesPayload.tools).toHaveLength(1)
      expect(translation.messagesPayload.tool_choice).toEqual({
        type: toolChoice === "required" ? "any" : toolChoice,
      })
      const text = trailingUserMessageText(translation)
      expect(text).toContain('"codex_output_schema"')
      expect(text).not.toContain("Do not call any tools")
    }
  })

  test("appends a JSON object instruction for json_object formats", () => {
    const translation = translate({
      input: "Give me a title",
      text: { format: { type: "json_object" } },
    })

    const text = trailingUserMessageText(translation)
    expect(text).toContain("Respond with a single JSON object.")
    expect(text).not.toContain("Do not call any tools")
    expect(text).not.toContain("JSON schema:")
  })

  test("keeps tool call tips when a text format is specified", () => {
    for (const format of [
      {
        type: "json_schema",
        name: "codex_output_schema",
        schema: { type: "object" },
      },
      { type: "json_object" },
      { type: "text" },
    ] as const) {
      const withFormat = translateWithTips({
        input: "Give me a title",
        tools: [{ type: "function", name: "getWeather", parameters: null }],
        text: { format },
      })

      expect(JSON.stringify(withFormat.messagesPayload.system ?? "")).toContain(
        "# Tool Call Tips",
      )
    }

    const withoutFormat = translateWithTips({ input: "Give me a title" })
    expect(
      JSON.stringify(withoutFormat.messagesPayload.system ?? ""),
    ).toContain("# Tool Call Tips")
  })

  test("builds instructions for JSON formats and ignores text formats", () => {
    expect(
      buildOutputFormatInstruction({
        type: "json_schema",
        name: "codex_output_schema",
        schema: { type: "object" },
      }),
    ).toContain('"codex_output_schema"')
    expect(
      buildOutputFormatInstruction({
        type: "json_object",
      }),
    ).toContain("Respond with a single JSON object.")
    expect(buildOutputFormatInstruction({ type: "text" })).toBeNull()
    expect(buildOutputFormatInstruction(null)).toBeNull()
    expect(buildOutputFormatInstruction(undefined)).toBeNull()
  })

  test("keeps tools available for text formats without instructions", () => {
    const plainText = translate({
      input: "hello",
      tools: [{ type: "function", name: "getWeather", parameters: null }],
      tool_choice: "auto",
      text: { format: { type: "text" } },
    })
    expect(plainText.messagesPayload.tools).toHaveLength(1)
    expect(plainText.messagesPayload.tool_choice).toEqual({ type: "auto" })
    expect(trailingUserMessageText(plainText)).toBe("hello")

    const emptyFormat = translate({
      input: "hello",
      text: { format: null },
    })
    expect(emptyFormat.messagesPayload.messages).toHaveLength(1)
    expect(emptyFormat.messagesPayload.tool_choice).toBeUndefined()

    const noTextConfig = translate({ input: "hello" })
    expect(noTextConfig.messagesPayload.messages).toHaveLength(1)
  })

  test("marks reasoning translated from a Messages response", () => {
    const translation = translate({ input: "Explain the result" })
    const result = translateAnthropicToResponses(
      {
        content: [
          {
            type: "thinking",
            thinking: "Check the result.",
            signature: "claude-signature",
          },
        ],
        id: "msg_reasoning",
        model: "claude-sonnet-4.6",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 8, output_tokens: 3 },
      },
      translation,
    )

    expect(result.output[0]).toMatchObject({
      type: "reasoning",
      encrypted_content: "claude-signature",
    })
    expect(result.output[0]?.id?.endsWith("__a1")).toBe(true)
  })

  test.each([false, true])("restores custom calls %j", (namespaced) => {
    const translation = translate({
      input: [
        {
          role: "developer",
          tools:
            namespaced ?
              [
                {
                  type: "namespace",
                  name: "functions",
                  tools: [{ type: "custom", name: "apply_patch" }],
                },
              ]
            : [{ type: "custom", name: "apply_patch" }],
          type: "additional_tools",
        },
        { role: "user", content: "Patch it", type: "message" },
      ],
    })
    const response: AnthropicResponse = {
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "apply_patch",
          input: { input: "*** Begin Patch" },
        },
      ],
      id: "msg_1",
      model: "claude-sonnet-4.6",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 10, output_tokens: 4 },
    }

    const result = translateAnthropicToResponses(response, translation)
    expect(result.output[0]?.id).toMatch(/^ctc_/)
    expect(result.output).toMatchObject([
      {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "apply_patch",
        input: "*** Begin Patch",
        ...(namespaced ? { namespace: "functions" } : {}),
      },
    ])
  })

  test.each([false, true])("streams custom calls %j", async (namespaced) => {
    const translation = translate({
      input: [
        {
          role: "developer",
          tools:
            namespaced ?
              [
                {
                  type: "namespace",
                  name: "functions",
                  tools: [{ type: "custom", name: "apply_patch" }],
                },
              ]
            : [{ type: "custom", name: "apply_patch" }],
          type: "additional_tools",
        },
        { role: "user", content: "Patch it", type: "message" },
      ],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-stream",
          name: "apply_patch",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"input": "*** Begin',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: ' Patch"',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "}" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    const toolDeltas = events.flatMap((event) =>
      event.type === "response.custom_tool_call_input.delta" ?
        [event.delta]
      : [],
    )
    expect(toolDeltas).toEqual(["*** Begin", " Patch"])
    const toolDone = events.find(
      (event) => event.type === "response.custom_tool_call_input.done",
    )
    expect(toolDone?.type).toBe("response.custom_tool_call_input.done")
    if (toolDone?.type === "response.custom_tool_call_input.done") {
      expect(typeof toolDone.item_id).toBe("string")
      expect(toolDone.name).toBe("apply_patch")
      expect(toolDone.input).toBe("*** Begin Patch")
    }
    const outputDone = events.find(
      (event) =>
        event.type === "response.output_item.done"
        && event.item.type === "custom_tool_call",
    )
    expect(outputDone?.type).toBe("response.output_item.done")
    if (
      outputDone?.type === "response.output_item.done"
      && outputDone.item.type === "custom_tool_call"
    ) {
      expect(outputDone.item.id).toMatch(/^ctc_/)
      expect(outputDone.item).toMatchObject({
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch",
        status: "completed",
        ...(namespaced ? { namespace: "functions" } : {}),
      })
    }
    const completed = events.at(-1)
    expect(completed?.type).toBe("response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.output).toEqual([])
    }
  })

  test("uses an empty encrypted content fallback for unsigned stream reasoning", async () => {
    const translation = translate({
      input: "Explain the result",
      stream: true,
    })
    const signature = Buffer.from("real-signature", "utf8").toString("base64")
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_reasoning_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "Unsigned reasoning" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "Signed reasoning" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "signature_delta", signature },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }
    const reasoningItems = events.flatMap((event) => {
      if (
        event.type !== "response.output_item.added"
        && event.type !== "response.output_item.done"
      ) {
        return []
      }
      return event.item.type === "reasoning" ? [event.item] : []
    })

    expect(reasoningItems).toHaveLength(4)
    expect(new Set(reasoningItems.map((item) => item.id)).size).toBe(2)
    expect(reasoningItems.every((item) => item.id.endsWith("__a1"))).toBe(true)
    expect(reasoningItems[0]?.encrypted_content).toBe("")
    expect(reasoningItems[1]?.encrypted_content).toBe("")
    expect(reasoningItems[2]?.encrypted_content).toBe("")
    expect(reasoningItems[3]?.encrypted_content).toBe(signature)
    expectCanonicalBase64(reasoningItems[3]?.encrypted_content)
  })

  test("uses Base64 encrypted content for stream compaction", async () => {
    const translation = translate({
      input: [
        { role: "user", content: "Implement the feature", type: "message" },
        { type: "compaction_trigger" },
      ],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_compaction_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Current progress" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " and next steps" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }
    const compaction = events.find(
      (event) =>
        event.type === "response.output_item.done"
        && event.item.type === "compaction",
    )

    expect(compaction?.type).toBe("response.output_item.done")
    if (
      compaction?.type === "response.output_item.done"
      && compaction.item.type === "compaction"
    ) {
      expectCanonicalBase64(compaction.item.encrypted_content)
      expect(decodeMessagesCompaction(compaction.item.encrypted_content)).toBe(
        "Current progress and next steps",
      )
    }
  })

  test("streams initial custom tool input without terminal output", async () => {
    const translation = translate({
      input: "Patch it",
      tools: [{ type: "custom", name: "apply_patch" }],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_initial_input",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-initial",
          name: "apply_patch",
          input: { input: "from start" },
        },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    const delta = events.find(
      (event) => event.type === "response.custom_tool_call_input.delta",
    )
    expect(delta).toMatchObject({ delta: "from start" })
    const completed = events.at(-1)
    expect(completed?.type).toBe("response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.output).toEqual([])
    }
  })

  test("keeps function tool arguments incremental after state cleanup", async () => {
    const translation = translate({
      input: "Read files",
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
          strict: false,
        },
      ],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_function_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-first",
          name: "read_file",
          input: { path: "first" },
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call-second",
          name: "read_file",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"second"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    const deltas = events.flatMap((event) =>
      event.type === "response.function_call_arguments.delta" ?
        [event.delta]
      : [],
    )
    expect(deltas).toEqual(['{"path":"first"}', '{"path":', '"second"}'])
    const doneEvents = events.filter(
      (event) => event.type === "response.function_call_arguments.done",
    )
    expect(doneEvents).toHaveLength(2)
    expect(
      events
        .filter((event) => event.type === "response.output_item.added")
        .map((event) =>
          event.type === "response.output_item.added" ? event.output_index : -1,
        ),
    ).toEqual([0, 1])
  })

  test("fails malformed custom input without terminal output items", async () => {
    const translation = translate({
      input: "Patch it",
      tools: [{ type: "custom", name: "apply_patch" }],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_invalid_custom",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-invalid",
          name: "apply_patch",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"wrong":' },
      },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    expect(events.some((event) => event.type === "error")).toBe(true)
    expect(
      events.some(
        (event) => event.type === "response.custom_tool_call_input.done",
      ),
    ).toBe(false)
    const failed = events.at(-1)
    expect(failed?.type).toBe("response.failed")
    if (failed?.type === "response.failed") {
      expect(failed.response.output).toEqual([])
    }
  })

  test("omits output from synthesized terminal stream events", () => {
    const translation = translate({ input: "hello", stream: true })
    const result = translateAnthropicToResponses(
      {
        content: [{ type: "text", text: "hello" }],
        id: "msg_synthesized",
        model: "claude-sonnet-4.6",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 2, output_tokens: 1 },
      },
      translation,
    )

    const events = responsesResultToStreamEvents(result)
    expect(
      events.some((event) => event.type === "response.output_item.done"),
    ).toBe(true)
    const completed = events.at(-1)
    expect(completed?.type).toBe("response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.output).toEqual([])
    }
  })

  test("fails the response when the stream breaks during thinking output", async () => {
    const translation = translate({ input: "hello", stream: true })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_thinking_cut",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "partial thought" },
      },
      // The stream is interrupted here: no content_block_stop, no
      // message_delta and no message_stop ever arrive.
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    expect(events.some((event) => event.type === "response.completed")).toBe(
      false,
    )
    const error = events.find((event) => event.type === "error")
    expect(error?.type).toBe("error")
    if (error?.type === "error") {
      expect(error.message).toBe(
        "Messages stream ended without a message_stop event",
      )
    }
    const failed = events.at(-1)
    expect(failed?.type).toBe("response.failed")
    if (failed?.type === "response.failed") {
      expect(failed.response.status).toBe("failed")
    }
  })

  test("emits failure events when the stream ends before initialization", async () => {
    const translation = translate({ input: "hello", stream: true })
    async function* chunks() {
      await Promise.resolve()
      yield { data: "[DONE]" }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "error",
      "response.failed",
    ])
    expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3])
    const error = events[2]
    if (error?.type === "error") {
      expect(error.message).toBe("Messages API returned an empty stream")
    }
    const failed = events[3]
    if (failed?.type === "response.failed") {
      expect(failed.response.status).toBe("failed")
    }
  })

  test("emits failure events when upstream errors before initialization", async () => {
    const translation = translate({ input: "hello", stream: true })
    async function* chunks() {
      await Promise.resolve()
      yield {
        data: JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
      }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "error",
      "response.failed",
    ])
    const error = events[2]
    if (error?.type === "error") {
      expect(error.message).toBe("Overloaded")
    }
    const failed = events[3]
    if (failed?.type === "response.failed") {
      expect(failed.response.status).toBe("failed")
    }
  })
})
