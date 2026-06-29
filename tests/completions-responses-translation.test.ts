import { describe, expect, it } from "bun:test"

import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputMessage,
  ResponseOutputFunctionCall,
  ResponseOutputMessage,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  translateCompletionsToResponsesPayload,
  translateResponsesResultToCompletions,
} from "~/routes/chat-completions/completions-responses-translation"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basePayload = (
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload =>
  ({
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }) as ChatCompletionsPayload

const baseResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  id: "resp-1",
  object: "response",
  created_at: 1000,
  model: "gpt-5.4-mini",
  output: [],
  output_text: "",
  status: "completed",
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: null,
  tools: [],
  top_p: null,
  ...overrides,
})

const sampleTools: Array<Tool> = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Gets the weather",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Payload translation: Completions -> Responses
// ---------------------------------------------------------------------------

describe("translateCompletionsToResponsesPayload", () => {
  describe("message translation", () => {
    it("hoists a system message into instructions", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "hi" },
          ],
        }),
      )

      expect(result.instructions).toBe("You are helpful.")
      const input = result.input as Array<ResponseInputMessage>
      expect(input).toHaveLength(1)
      expect(input[0].role).toBe("user")
    })

    it("concatenates multiple system messages with double newline", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            { role: "system", content: "Rule one." },
            { role: "developer", content: "Rule two." },
            { role: "user", content: "hi" },
          ],
        }),
      )

      expect(result.instructions).toBe("Rule one.\n\nRule two.")
    })

    it("sets instructions to null when no system messages present", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [{ role: "user", content: "hello" }],
        }),
      )

      expect(result.instructions).toBeNull()
    })

    it("translates user and assistant messages into input", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            { role: "user", content: "question" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "follow-up" },
          ],
        }),
      )

      const input = result.input as Array<ResponseInputMessage>
      expect(input).toHaveLength(3)
      expect(input[0].role).toBe("user")
      expect(input[1].role).toBe("assistant")
      expect(input[2].role).toBe("user")
    })

    it("translates tool messages into function_call_output", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            {
              role: "tool",
              content: "sunny, 22C",
              tool_call_id: "call-1",
            } as Message,
          ],
        }),
      )

      const input = result.input as Array<ResponseFunctionCallOutputItem>
      expect(input).toHaveLength(1)
      expect(input[0]).toEqual({
        type: "function_call_output",
        call_id: "call-1",
        output: "sunny, 22C",
      })
    })

    it("translates assistant tool_calls into function_call items", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"location":"London"}',
                  },
                },
              ],
            } as Message,
          ],
        }),
      )

      const input = result.input as Array<ResponseFunctionToolCallItem>
      const fc = input.find((item) => item.type === "function_call")
      expect(fc).toBeDefined()
      expect(fc!.call_id).toBe("call-1")
      expect(fc!.name).toBe("get_weather")
      expect(fc!.arguments).toBe('{"location":"London"}')
      expect(fc!.status).toBe("completed")
    })
  })

  describe("content part translation", () => {
    it("translates text parts to input_text", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello world" }],
            },
          ],
        }),
      )

      const input = result.input as Array<ResponseInputMessage>
      const content = input[0].content as Array<{ type: string; text: string }>
      expect(content[0]).toEqual({ type: "input_text", text: "hello world" })
    })

    it("translates image_url parts to input_image", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: "https://example.com/img.png",
                    detail: "high",
                  },
                },
              ],
            },
          ],
        }),
      )

      const input = result.input as Array<ResponseInputMessage>
      const content = input[0].content as Array<Record<string, unknown>>
      expect(content[0]).toEqual({
        type: "input_image",
        image_url: "https://example.com/img.png",
        detail: "high",
      })
    })

    it("defaults image detail to auto when omitted", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://example.com/img.png" },
                },
              ],
            },
          ],
        }),
      )

      const input = result.input as Array<ResponseInputMessage>
      const content = input[0].content as Array<Record<string, unknown>>
      expect(content[0].detail).toBe("auto")
    })

    it("translates string content directly", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          messages: [{ role: "user", content: "plain string" }],
        }),
      )

      const input = result.input as Array<ResponseInputMessage>
      expect(input[0].content).toBe("plain string")
    })
  })

  describe("tools translation", () => {
    it("translates tools array to function tools", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ tools: sampleTools }),
      )

      expect(result.tools).toEqual([
        {
          type: "function",
          name: "get_weather",
          description: "Gets the weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
          strict: null,
        },
      ])
    })

    it("returns undefined for null tools", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ tools: null }),
      )

      expect(result.tools).toBeUndefined()
    })

    it("returns undefined for empty tools array", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ tools: [] }),
      )

      expect(result.tools).toBeUndefined()
    })
  })

  describe("tool_choice translation", () => {
    it("passes string tool_choice through", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ tool_choice: "auto" }),
      )

      expect(result.tool_choice).toBe("auto")
    })

    it("translates object tool_choice to function form", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          tool_choice: {
            type: "function",
            function: { name: "get_weather" },
          },
        }),
      )

      expect(result.tool_choice).toEqual({
        type: "function",
        name: "get_weather",
      })
    })

    it("returns undefined when tool_choice is absent", () => {
      const result = translateCompletionsToResponsesPayload(basePayload())

      expect(result.tool_choice).toBeUndefined()
    })
  })

  describe("response_format translation", () => {
    it("translates json_object format", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          response_format: { type: "json_object" },
        }),
      )

      const text = result.text as { format: Record<string, unknown> }
      expect(text).toEqual({
        format: { type: "json_object" },
      })
    })

    it("translates json_schema format with strict", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "extract",
              schema: {
                type: "object",
                properties: {
                  facts: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                      },
                    },
                  },
                },
              },
              strict: true,
            },
          },
        }),
      )

      const text = result.text as { format: Record<string, unknown> }
      expect(text.format.type).toBe("json_schema")
      expect(text.format.name).toBe("extract")
      expect(text.format.strict).toBe(true)
    })

    it("defaults strict to true when omitted in json_schema", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "test",
              schema: { type: "object", properties: {} },
            },
          },
        }),
      )

      const text = result.text as { format: Record<string, unknown> }
      expect(text.format.strict).toBe(true)
    })

    it("returns undefined when response_format is absent", () => {
      const result = translateCompletionsToResponsesPayload(basePayload())

      expect(result.text).toBeUndefined()
    })
  })

  describe("ensureAdditionalPropertiesFalse", () => {
    it("injects additionalProperties: false into object schemas", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "test",
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
              },
              strict: true,
            },
          },
        }),
      )

      const text = result.text as {
        format: { schema: Record<string, unknown> }
      }
      expect(text.format.schema.additionalProperties).toBe(false)
    })

    it("recursively patches nested object properties", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "test",
              schema: {
                type: "object",
                properties: {
                  address: {
                    type: "object",
                    properties: {
                      city: { type: "string" },
                    },
                  },
                },
              },
              strict: true,
            },
          },
        }),
      )

      const text = result.text as {
        format: { schema: Record<string, unknown> }
      }
      const address = (
        text.format.schema.properties as Record<string, Record<string, unknown>>
      ).address
      expect(address.additionalProperties).toBe(false)
    })

    it("patches object items inside arrays", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "test",
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "number" },
                      },
                    },
                  },
                },
              },
              strict: true,
            },
          },
        }),
      )

      const text = result.text as {
        format: { schema: Record<string, unknown> }
      }
      const items = (
        text.format.schema.properties as Record<string, Record<string, unknown>>
      ).items
      const arrayItems = items.items as Record<string, unknown>
      expect(arrayItems.additionalProperties).toBe(false)
    })

    it("does not mutate the original schema", () => {
      const originalSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      }
      const frozen = JSON.parse(
        JSON.stringify(originalSchema),
      ) as typeof originalSchema

      translateCompletionsToResponsesPayload(
        basePayload({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "test",
              schema: originalSchema,
              strict: true,
            },
          },
        }),
      )

      expect(originalSchema).toEqual(frozen)
    })
  })

  describe("parallel_tool_calls", () => {
    it("defaults to true when absent", () => {
      const result = translateCompletionsToResponsesPayload(basePayload())

      expect(result.parallel_tool_calls).toBe(true)
    })

    it("preserves explicit false", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ parallel_tool_calls: false }),
      )

      expect(result.parallel_tool_calls).toBe(false)
    })
  })

  describe("reasoning effort", () => {
    it("uses explicit reasoning_effort from payload", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ reasoning_effort: "medium" }),
      )

      expect(result.reasoning).toEqual({ effort: "medium" })
    })

    it("falls back to config when payload has no reasoning_effort", () => {
      // getReasoningEffortForModel defaults to "high" per config.ts
      const result = translateCompletionsToResponsesPayload(basePayload())

      expect(result.reasoning).toBeDefined()
      expect(result.reasoning!.effort).toBeTruthy()
    })
  })

  describe("field mapping", () => {
    it("omits temperature", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ temperature: 0.7 }),
      )

      expect(result).not.toHaveProperty("temperature")
    })

    it("maps max_completion_tokens to max_output_tokens", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ max_completion_tokens: 500 }),
      )

      expect(result.max_output_tokens).toBe(500)
    })

    it("falls back to max_tokens for max_output_tokens", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ max_tokens: 300 }),
      )

      expect(result.max_output_tokens).toBe(300)
    })

    it("sets store to false", () => {
      const result = translateCompletionsToResponsesPayload(basePayload())

      expect(result.store).toBe(false)
    })

    it("passes model through", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ model: "gpt-5.5" }),
      )

      expect(result.model).toBe("gpt-5.5")
    })

    it("passes stream through", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ stream: true }),
      )

      expect(result.stream).toBe(true)
    })

    it("passes user through", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ user: "user-123" }),
      )

      expect(result.user).toBe("user-123")
    })

    it("passes top_p through", () => {
      const result = translateCompletionsToResponsesPayload(
        basePayload({ top_p: 0.9 }),
      )

      expect(result.top_p).toBe(0.9)
    })
  })
})

// ---------------------------------------------------------------------------
// Result translation: Responses -> Completions
// ---------------------------------------------------------------------------

describe("translateResponsesResultToCompletions", () => {
  it("translates a text response", () => {
    const result = translateResponsesResultToCompletions(
      baseResult({
        output: [
          {
            id: "msg-1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Hello there!",
                annotations: [],
              },
            ],
          } satisfies ResponseOutputMessage,
        ],
      }),
    )

    expect(result.id).toBe("resp-1")
    expect(result.object).toBe("chat.completion")
    expect(result.model).toBe("gpt-5.4-mini")
    expect(result.choices).toHaveLength(1)
    expect(result.choices[0].message.role).toBe("assistant")
    expect(result.choices[0].message.content).toBe("Hello there!")
    expect(result.choices[0].finish_reason).toBe("stop")
    expect(result.choices[0].logprobs).toBeNull()
  })

  it("sets content to null when no text output", () => {
    const result = translateResponsesResultToCompletions(
      baseResult({ output: [] }),
    )

    expect(result.choices[0].message.content).toBeNull()
  })

  it("translates function calls to tool_calls", () => {
    const result = translateResponsesResultToCompletions(
      baseResult({
        output: [
          {
            id: "fc-1",
            type: "function_call",
            call_id: "call-1",
            name: "get_weather",
            arguments: '{"location":"London"}',
            status: "completed",
          } satisfies ResponseOutputFunctionCall,
        ],
      }),
    )

    expect(result.choices[0].message.tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"location":"London"}',
        },
      },
    ])
    expect(result.choices[0].finish_reason).toBe("tool_calls")
  })

  it("omits tool_calls when no function calls present", () => {
    const result = translateResponsesResultToCompletions(
      baseResult({ output: [] }),
    )

    expect(result.choices[0].message).not.toHaveProperty("tool_calls")
  })

  describe("finish_reason", () => {
    it("returns stop for normal completion", () => {
      const result = translateResponsesResultToCompletions(baseResult())

      expect(result.choices[0].finish_reason).toBe("stop")
    })

    it("returns length for max_output_tokens", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({
          incomplete_details: { reason: "max_output_tokens" },
        }),
      )

      expect(result.choices[0].finish_reason).toBe("length")
    })

    it("returns content_filter for content_filter", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({
          incomplete_details: { reason: "content_filter" },
        }),
      )

      expect(result.choices[0].finish_reason).toBe("content_filter")
    })

    it("returns tool_calls when function calls present even with incomplete_details", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({
          output: [
            {
              id: "fc-1",
              type: "function_call",
              call_id: "call-1",
              name: "fn",
              arguments: "{}",
              status: "completed",
            } satisfies ResponseOutputFunctionCall,
          ],
          incomplete_details: { reason: "max_output_tokens" },
        }),
      )

      expect(result.choices[0].finish_reason).toBe("tool_calls")
    })
  })

  describe("usage translation", () => {
    it("translates usage tokens", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
        }),
      )

      expect(result.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      })
    })

    it("includes cached tokens in prompt_tokens_details", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 80 },
          },
        }),
      )

      expect(result.usage?.prompt_tokens_details).toEqual({
        cached_tokens: 80,
      })
    })

    it("omits prompt_tokens_details when no cached tokens", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
        }),
      )

      expect(result.usage).not.toHaveProperty("prompt_tokens_details")
    })

    it("returns undefined usage when null", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({ usage: null }),
      )

      expect(result.usage).toBeUndefined()
    })
  })

  describe("copilot_usage", () => {
    it("preserves copilot_usage when present", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({
          copilot_usage: { total_nano_aiu: 42 },
        }),
      )

      expect(result.copilot_usage).toEqual({ total_nano_aiu: 42 })
    })

    it("omits copilot_usage key when absent", () => {
      const result = translateResponsesResultToCompletions(baseResult())

      expect(result).not.toHaveProperty("copilot_usage")
    })

    it("omits copilot_usage key when null", () => {
      const result = translateResponsesResultToCompletions(
        baseResult({ copilot_usage: null }),
      )

      expect(result).not.toHaveProperty("copilot_usage")
    })
  })
})
