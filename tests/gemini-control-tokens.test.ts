import { describe, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"

import * as tokenUsage from "~/lib/token-usage"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "~/lib/types/anthropic"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/lib/types/chat-completions"
import type { ResolvedProviderConfig } from "~/lib/config"
import type { Model } from "~/lib/types/models"
import {
  handleWithChatCompletions,
  messagesApiFlowDependencies,
} from "~/routes/messages/api-flows"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/completions-stream-translation"
import { translateToAnthropic } from "~/routes/messages/completions-translation"
import {
  createGeminiTextSanitizerState,
  finishGeminiTextSanitizer,
  GEMINI_CONTROL_TOKENS,
  isGeminiControlTokenModel,
  pushGeminiTextChunk,
  stripGeminiControlTokens,
} from "~/routes/messages/gemini-control-tokens"
import { GoogleMessagesStreamTranslator } from "~/routes/messages/google-stream-translation"
import {
  translateAnthropicToGoogle,
  translateGoogleToAnthropic,
} from "~/routes/messages/google-translation"
import { handleOpenAICompatibleProviderMessages } from "~/routes/provider/messages/handlers/openai-compatible"
import {
  handleResponsesViaMessages,
  responsesMessagesDependencies,
} from "~/routes/responses/messages-handler"

const createStreamState = (): AnthropicStreamState => ({
  messageStartSent: false,
  messageCompleted: false,
  contentBlockIndex: 0,
  contentBlockOpen: false,
  toolCalls: {},
  thinkingBlockOpen: false,
})

function runChunkedSanitizer(chunks: Array<string>): string {
  const state = createGeminiTextSanitizerState()
  let output = ""
  for (const chunk of chunks) {
    output += pushGeminiTextChunk(state, chunk)
  }
  output += finishGeminiTextSanitizer(state)
  return output
}

function splitEvery(input: string, size: number): Array<string> {
  const result: Array<string> = []
  for (let i = 0; i < input.length; i += size) {
    result.push(input.slice(i, i + size))
  }
  return result
}

const parseSseEvents = (raw: string): Array<AnthropicStreamEventData> =>
  raw
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as AnthropicStreamEventData)

describe("Gemini model detection and control-token sanitizer", () => {
  test("identifies Gemini and Gemma models by model ID or Google vendor", () => {
    for (const model of [
      "gemini-4-carbon",
      "gemini-3.8-flash",
      "gemini",
      "google/gemini-2.5-pro",
      "models/gemini-2.5-flash",
      "vertex_ai/gemini_2_5_pro",
      "gemma-3-27b-it",
    ]) {
      expect(isGeminiControlTokenModel(model)).toBe(true)
    }

    expect(isGeminiControlTokenModel("custom-alias", "Google")).toBe(true)
    expect(isGeminiControlTokenModel("custom-alias", " google ")).toBe(true)

    for (const model of [
      undefined,
      null,
      "",
      "gpt-4o-2024-05-13",
      "claude-opus-4-6",
      "deepseek-v4.1-flash",
      "kimi-k3",
      "qwen-plus",
      "mygeminiapp",
    ]) {
      expect(isGeminiControlTokenModel(model)).toBe(false)
    }
  })

  test("maintains exact non-stream and chunked-stream parity across edge cases", () => {
    const cases: Array<[input: string, expected: string]> = [
      ...GEMINI_CONTROL_TOKENS.map((token): [string, string] => [token, ""]),
      ["<end_of_image>".repeat(13), ""],
      ["  <end_of_image>\n<end_of_turn>\t<eos>  ", ""],
      ["<start_of_image><end_of_image>\nHello world", "Hello world"],
      ["Hello world.<end_of_image><end_of_turn>\n", "Hello world."],
      ["<start_of_turn>Answer text<end_of_turn>", "Answer text"],
      [
        "Gemini leaked `<end_of_image>` before stopping.",
        "Gemini leaked `<end_of_image>` before stopping.",
      ],
      ['const pattern = "<end_of_image>"', 'const pattern = "<end_of_image>"'],
      ["<pad>123</pad>", "<pad>123</pad>"],
      ["<div>hello</div>", "<div>hello</div>"],
      ["a < b && c > d", "a < b && c > d"],
      ["   ", "   "],
      ["  Hello", "  Hello"],
      [
        `${" ".repeat(70)}<end_of_image>Hello`,
        `${" ".repeat(70)}<end_of_image>Hello`,
      ],
      ["<end_of", "<end_of"],
      ["Hello<end_of", "Hello<end_of"],
      ["<end_of_image><end_of", "<end_of"],
      ["Hello<end_of_image><end_of", "Hello<end_of_image><end_of"],
      ["Hello<end_of_<end_of_image>", "Hello<end_of_"],
      [
        "Hello<end_of_image><end_of_<end_of_image>",
        "Hello<end_of_image><end_of_",
      ],
    ]

    for (const [input, expected] of cases) {
      expect(stripGeminiControlTokens(input)).toBe(expected)
      expect(runChunkedSanitizer(["", input, ""])).toBe(expected)
      for (const chunkSize of [1, 2, 3, 5, 7, 13]) {
        expect(runChunkedSanitizer(splitEvery(input, chunkSize))).toBe(expected)
      }
    }
  })

  test("bounds trailing hold buffer on degenerate repeated control-token loops", () => {
    const state = createGeminiTextSanitizerState()
    expect(pushGeminiTextChunk(state, "Summary complete.")).toBe(
      "Summary complete.",
    )
    for (let i = 0; i < 2_000; i++) {
      expect(pushGeminiTextChunk(state, "<end_of_image>\n")).toBe("")
      expect(state.buffer.length).toBeLessThanOrEqual(16_400)
    }
    expect(finishGeminiTextSanitizer(state)).toBe("")
    expect(
      stripGeminiControlTokens(
        `Summary complete.${"<end_of_image>".repeat(2_000)}`,
      ),
    ).toBe("Summary complete.")
  })
})

describe("Gemini leaked control token sanitization", () => {
  test("drops pure <end_of_image> Chat Completions stream without opening a text block", () => {
    const state = createStreamState()
    const chunks: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-gemini-pure",
        object: "chat.completion.chunk",
        created: 0,
        model: "gemini-4-carbon",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "<end_of_" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-gemini-pure",
        object: "chat.completion.chunk",
        created: 0,
        model: "gemini-4-carbon",
        choices: [
          {
            index: 0,
            delta: { content: "image><end_of_image>" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-gemini-pure",
        object: "chat.completion.chunk",
        created: 0,
        model: "gemini-4-carbon",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      },
    ]

    const events = [
      ...chunks.flatMap((chunk) =>
        translateChunkToAnthropicEvents(chunk, state),
      ),
      ...flushPendingAnthropicStreamEvents(state),
    ]

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ])
  })

  test("drops pure <end_of_image> in non-streaming Chat Completions and Google translations", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "cmpl-gemini-json",
      object: "chat.completion",
      created: 0,
      model: "gemini-4-carbon",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "<end_of_image>".repeat(13),
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }
    expect(translateToAnthropic(openAIResponse).content).toEqual([])

    const googleJson = translateGoogleToAnthropic(
      {
        candidates: [
          {
            content: { parts: [{ text: "<end_of_image><end_of_image>" }] },
            finishReason: "STOP",
          },
        ],
      },
      "gemini-4-carbon",
    )
    expect(googleJson.content).toEqual([])

    const googleStream = new GoogleMessagesStreamTranslator("gemini-4-carbon")
    const googleEvents = [
      ...googleStream.push({
        candidates: [{ content: { parts: [{ text: "<end_of_" }] } }],
      }),
      ...googleStream.push({
        candidates: [
          {
            content: { parts: [{ text: "image><end_of_image>" }] },
            finishReason: "STOP",
          },
        ],
      }),
      ...googleStream.finish(),
    ]
    expect(googleEvents.map((event) => event.type)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ])
  })

  test("preserves thinking signatures when Gemini leaks <end_of_image> before tool calls or finish", () => {
    const thinkingState = createStreamState()
    const thinkingEvents = [
      ...translateChunkToAnthropicEvents(
        {
          id: "cmpl-think",
          object: "chat.completion.chunk",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              delta: { reasoning_text: "Checking context" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        thinkingState,
      ),
      ...translateChunkToAnthropicEvents(
        {
          id: "cmpl-think",
          object: "chat.completion.chunk",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              delta: { content: "<end_of_image>" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        thinkingState,
      ),
      ...translateChunkToAnthropicEvents(
        {
          id: "cmpl-think",
          object: "chat.completion.chunk",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              delta: { reasoning_opaque: "sig-1" },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
        thinkingState,
      ),
    ]

    expect(thinkingEvents).toMatchObject([
      { type: "message_start" },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Checking context" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-1" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta" },
      { type: "message_stop" },
    ])

    const toolState = createStreamState()
    const toolEvents = [
      ...translateChunkToAnthropicEvents(
        {
          id: "cmpl-tool",
          object: "chat.completion.chunk",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              delta: {
                content: "<end_of_image>",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        toolState,
      ),
      ...translateChunkToAnthropicEvents(
        {
          id: "cmpl-tool",
          object: "chat.completion.chunk",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              delta: { content: "<end_of_image>" },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
        toolState,
      ),
    ]

    expect(
      toolEvents.filter((event) => event.type === "content_block_start"),
    ).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_1",
          name: "read",
          input: {},
        },
      },
    ])
  })

  test("sanitizes deferred content and non-streaming array parts for Gemini while leaving non-Gemini models untouched", () => {
    const deferredState = createStreamState()
    const deferredEvents = [
      ...translateChunkToAnthropicEvents(
        {
          id: "cmpl-deferred",
          object: "chat.completion.chunk",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        deferredState,
      ),
      ...translateChunkToAnthropicEvents(
        {
          id: "cmpl-deferred",
          object: "chat.completion.chunk",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              delta: { content: "<end_of_image>After tool<end_of_turn>" },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
        },
        deferredState,
      ),
    ]
    expect(deferredEvents).toContainEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "After tool" },
    })

    const nonGemini = translateToAnthropic({
      id: "cmpl-gpt",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "<end_of_image>" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    })
    expect(nonGemini.content).toEqual([
      { type: "text", text: "<end_of_image>" },
    ])

    const vendorOverride = translateToAnthropic(
      {
        id: "cmpl-alias",
        object: "chat.completion",
        created: 0,
        model: "custom-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "<end_of_image>" },
                { type: "text", text: "Clean output<eos>" },
              ] as unknown as string,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
      { vendor: "Google" },
    )
    expect(vendorOverride.content).toEqual([
      { type: "text", text: "Clean output" },
    ])
  })

  test("does not let stripped Google control-token parts overwrite earlier thought signatures", () => {
    const jsonResponse = translateGoogleToAnthropic(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Plan",
                  thought: true,
                  thoughtSignature: "thought-sig",
                },
                {
                  text: "<end_of_image><end_of_image>",
                  thoughtSignature: "leaked-sig",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
      "gemini-4-carbon",
    )
    expect(jsonResponse.content).toHaveLength(1)
    const restoredJson = translateAnthropicToGoogle({
      model: "gemini-4-carbon",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content:
            jsonResponse.content as AnthropicMessagesPayload["messages"][number] extends (
              never
            ) ?
              never
            : Array<
                Extract<
                  AnthropicResponse["content"][number],
                  { type: "text" | "thinking" | "tool_use" }
                >
              >,
        },
      ],
    })
    expect(restoredJson.contents[1].parts).toEqual([
      { text: "Plan", thought: true, thoughtSignature: "thought-sig" },
    ])

    const translator = new GoogleMessagesStreamTranslator("gemini-4-carbon")
    const streamEvents = [
      ...translator.push({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "Plan",
                  thought: true,
                  thoughtSignature: "thought-sig",
                },
              ],
            },
          },
        ],
      }),
      ...translator.push({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "<end_of_image>",
                  thoughtSignature: "leaked-sig",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
      ...translator.finish(),
    ]
    expect(
      streamEvents.filter((event) => event.type === "content_block_start"),
    ).toHaveLength(1)

    const partialBeforeTool = new GoogleMessagesStreamTranslator(
      "gemini-4-carbon",
    )
    const partialEvents = [
      ...partialBeforeTool.push({
        candidates: [{ content: { parts: [{ text: "<end_of" }] } }],
      }),
      ...partialBeforeTool.push({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { id: "call-1", name: "ls", args: {} } }],
            },
            finishReason: "STOP",
          },
        ],
      }),
      ...partialBeforeTool.finish(),
    ]
    expect(partialEvents).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "<end_of" },
    })
  })

  test("strips leaked tokens end-to-end across Copilot, openai-compatible, and /v1/responses Messages fallback", async () => {
    const recorderSpy = spyOn(
      tokenUsage,
      "createCopilotTokenUsageRecorder",
    ).mockImplementation(() => () => {})
    const providerRecorderSpy = spyOn(
      tokenUsage,
      "createProviderTokenUsageRecorder",
    ).mockImplementation(() => () => {})
    const originalCreateChat = messagesApiFlowDependencies.createChatCompletions
    const originalHandleMessages =
      responsesMessagesDependencies.handleCompletionPayload
    const originalFetch = globalThis.fetch

    try {
      const logger = {
        debug: () => {},
        warn: () => {},
        error: () => {},
      } as unknown as Parameters<typeof handleWithChatCompletions>[2]["logger"]

      messagesApiFlowDependencies.createChatCompletions = mock(
        async function* () {
          await Promise.resolve()
          yield {
            data: JSON.stringify({
              id: "cmpl-flow",
              object: "chat.completion.chunk",
              created: 0,
              model: "custom-google-model",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "<end_of_image>" },
                  finish_reason: "stop",
                  logprobs: null,
                },
              ],
            }),
          }
          yield { data: "[DONE]" }
        },
      ) as unknown as typeof messagesApiFlowDependencies.createChatCompletions

      const app = new Hono()
      app.post("/v1/messages", (c) =>
        handleWithChatCompletions(
          c,
          {
            model: "custom-google-model",
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          },
          {
            logger,
            requestId: "req-1",
            selectedModel: {
              id: "custom-google-model",
              name: "Custom Google",
              object: "model",
              vendor: "Google",
              version: "1",
              preview: false,
              model_picker_enabled: true,
              capabilities: {
                family: "gemini",
                limits: {},
                object: "model_capabilities",
                supports: {},
                tokenizer: "gemini",
                type: "chat",
              },
            } satisfies Model,
          },
        ),
      )

      const copilotStreamRes = await app.request("/v1/messages", {
        method: "POST",
      })
      const copilotEvents = parseSseEvents(await copilotStreamRes.text())
      expect(copilotEvents.map((event) => event.type)).toEqual([
        "message_start",
        "message_delta",
        "message_stop",
      ])

      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({
            id: "cmpl-provider",
            object: "chat.completion",
            created: 0,
            model: "upstream-alias",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "<end_of_image><end_of_image>",
                },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
          }),
        ),
      ) as unknown as typeof fetch

      const providerApp = new Hono()
      providerApp.post("/provider/v1/messages", (c) =>
        handleOpenAICompatibleProviderMessages(c, {
          modelConfig: undefined,
          payload: {
            model: "google/gemini-4-carbon",
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
          },
          provider: "openrouter",
          providerConfig: {
            name: "openrouter",
            type: "openai-compatible",
            baseUrl: "https://openrouter.example/v1",
            apiKey: "test-key",
          } as ResolvedProviderConfig,
        }),
      )
      const providerRes = await providerApp.request("/provider/v1/messages", {
        method: "POST",
      })
      const providerJson = (await providerRes.json()) as AnthropicResponse
      expect(providerJson.content).toEqual([])

      responsesMessagesDependencies.handleCompletionPayload = mock(() =>
        Promise.resolve(
          Response.json({
            id: "msg_empty_gemini",
            type: "message",
            role: "assistant",
            model: "gemini-4-carbon",
            content: [],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 2 },
          } satisfies AnthropicResponse),
        ),
      ) as unknown as typeof responsesMessagesDependencies.handleCompletionPayload

      const responsesApp = new Hono()
      responsesApp.post("/v1/responses", (c) =>
        handleResponsesViaMessages(c, {
          payload: {
            model: "gemini-4-carbon",
            input: "ping",
          },
          publicModel: "gemini-4-carbon",
          targetModel: "gemini-4-carbon",
        }),
      )
      const responsesRes = await responsesApp.request("/v1/responses", {
        method: "POST",
      })
      const responsesJson = (await responsesRes.json()) as {
        output: Array<unknown>
        output_text: string
        status: string
      }
      expect(responsesJson).toMatchObject({
        output: [],
        output_text: "",
        status: "completed",
      })
    } finally {
      messagesApiFlowDependencies.createChatCompletions = originalCreateChat
      responsesMessagesDependencies.handleCompletionPayload =
        originalHandleMessages
      globalThis.fetch = originalFetch
      recorderSpy.mockRestore()
      providerRecorderSpy.mockRestore()
    }
  })
})
