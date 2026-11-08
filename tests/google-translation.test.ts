import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import type { GoogleGenerateContentPayload } from "~/lib/types/google"
import type {
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
} from "~/lib/types/anthropic"
import {
  encodeGoogleSignature,
  getGoogleStopReason,
  translateAnthropicToGoogle,
  translateGoogleToAnthropic,
  translateGoogleUsage,
} from "~/routes/messages/google-translation"

const payload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "gemini-3.8-flash",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
})

describe("Messages to Google translation", () => {
  test("translates system prompts, sampling and consecutive conversation roles without mutating input", () => {
    const toolAdditionBlock = {
      type: "tool_addition",
      tool: {
        type: "tool_reference",
        name: "mcp__plugin_tool-search_tool_search__search",
      },
    } as unknown as AnthropicTextBlock
    const request = payload({
      system: [
        {
          type: "text",
          text: "Be brief",
          cache_control: { type: "ephemeral" },
        },
      ],
      temperature: 0,
      top_p: 0.8,
      top_k: 20,
      stop_sequences: ["END"],
      messages: [
        { role: "system", content: "Code assistant" },
        {
          role: "system",
          content: [{ type: "text", text: "Use tests" }, toolAdditionBlock],
        },
        {
          role: "system",
          content: "",
        },
        {
          role: "system",
          content: [{ type: "text", text: " \n\t" }],
        },
        { role: "user", content: "one" },
        { role: "user", content: [{ type: "text", text: "two" }] },
        { role: "assistant", content: "answer" },
        { role: "user", content: "" },
      ],
    })
    const original = structuredClone(request)
    const translated = translateAnthropicToGoogle(request)
    expect(translated).toMatchObject({
      systemInstruction: {
        parts: [{ text: "Be brief" }],
      },
      contents: [
        {
          role: "user",
          parts: [
            { text: "Code assistant" },
            { text: "Use tests" },
            { text: " \n\t" },
            { text: "one" },
            { text: "two" },
          ],
        },
        { role: "model", parts: [{ text: "answer" }] },
      ],
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: 1024,
        temperature: 0,
        topP: 0.8,
        topK: 20,
        stopSequences: ["END"],
      },
    })
    expect(request).toEqual(original)
    expect(
      translateAnthropicToGoogle(payload({ system: "plain" }))
        .systemInstruction,
    ).toEqual({ parts: [{ text: "plain" }] })
    expect(
      translateAnthropicToGoogle(payload()).systemInstruction,
    ).toBeUndefined()
  })

  test("translates images and PDFs both in user messages and tool results", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aW1n" },
    } as const
    const pdf = {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
    } as const
    const translated = translateAnthropicToGoogle(
      payload({
        model: "gemini-3.8-flash",
        messages: [
          { role: "user", content: [image, pdf] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "read",
                input: { path: "doc" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                is_error: true,
                content: [
                  { type: "text", text: "failed" },
                  image,
                  pdf,
                  { type: "tool_reference", tool_name: "read" },
                ],
              },
            ],
          },
        ],
      }),
    )
    expect(translated.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "aW1n" } },
      { inlineData: { mimeType: "application/pdf", data: "cGRm" } },
    ])
    const response = translated.contents[2].parts[0].functionResponse
    expect(response).toMatchObject({
      id: "call-1",
      name: "read",
      response: { error: { text: "failed\nread" } },
      parts: translated.contents[0].parts,
    })
    const names = response?.parts?.map((part) => part.inlineData?.displayName)
    expect(new Set(names).size).toBe(2)
    expect(response?.response).toEqual({
      error: {
        text: "failed\nread",
        media: names?.map((name) => ({ $ref: name })),
      },
    })
  })

  test("translates automatic, disabled, forced and named tool choices", () => {
    const cases: Array<{
      toolChoice: NonNullable<AnthropicMessagesPayload["tool_choice"]>
      expected: NonNullable<
        GoogleGenerateContentPayload["toolConfig"]
      >["functionCallingConfig"]
    }> = [
      { toolChoice: { type: "auto" }, expected: { mode: "AUTO" } },
      { toolChoice: { type: "none" }, expected: { mode: "NONE" } },
      { toolChoice: { type: "any" }, expected: { mode: "ANY" } },
      {
        toolChoice: { type: "tool", name: "read" },
        expected: { mode: "ANY", allowedFunctionNames: ["read"] },
      },
    ]
    for (const { toolChoice, expected } of cases) {
      const translated = translateAnthropicToGoogle(
        payload({
          tools: [
            {
              name: "read",
              description: "Read a file",
              input_schema: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          ],
          tool_choice: toolChoice,
        }),
      )
      expect(translated.toolConfig?.functionCallingConfig).toEqual(expected)
      expect(translated.tools?.[0].functionDeclarations[0]).toEqual({
        name: "read",
        description: "Read a file",
        parametersJsonSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      })
    }
  })

  test("reports unmatched tool results and unsupported server tools as bad requests", () => {
    expect(() =>
      translateAnthropicToGoogle(
        payload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "missing",
                  content: "result",
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(HTTPError)
    expect(() =>
      translateAnthropicToGoogle(
        payload({
          tools: [
            {
              name: "search",
              type: "tool_search_tool_regex_20251119",
              input_schema: {},
            },
          ],
        }),
      ),
    ).toThrow("server tool")
  })

  test("translates structured output and model-specific thinking settings", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
    }
    expect(
      translateAnthropicToGoogle(
        payload({ output_config: { format: { type: "json_schema", schema } } }),
      ).generationConfig,
    ).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    })
    expect(
      translateAnthropicToGoogle(payload({ thinking: { type: "disabled" } }))
        .generationConfig.thinkingConfig,
    ).toEqual({ includeThoughts: false, thinkingLevel: "LOW" })
    expect(
      translateAnthropicToGoogle(
        payload({ thinking: { type: "enabled", budget_tokens: 2048 } }),
      ).generationConfig.thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingLevel: "LOW" })
    expect(
      translateAnthropicToGoogle(
        payload({
          thinking: { type: "adaptive" },
          output_config: { effort: "max" },
        }),
      ).generationConfig.thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" })
    for (const [effort, thinkingLevel] of [
      ["low", "LOW"],
      ["medium", "MEDIUM"],
      ["high", "HIGH"],
      ["max", "HIGH"],
    ] as const) {
      expect(
        translateAnthropicToGoogle(
          payload({
            model: "gemini-3.8-flash",
            thinking: { type: "adaptive" },
            output_config: { effort },
          }),
        ).generationConfig.thinkingConfig,
      ).toEqual({ includeThoughts: true, thinkingLevel })
    }
  })

  test("round-trips parallel signed tool calls, signed text and thinking through Anthropic history", () => {
    const parts = [
      { text: "Plan", thought: true, thoughtSignature: "thought-sig" },
      { text: "Reading files", thoughtSignature: "text-sig" },
      {
        functionCall: { id: "call-a", name: "read", args: { path: "a" } },
        thoughtSignature: "tool-sig",
      },
      { functionCall: { id: "call-b", name: "read", args: { path: "b" } } },
    ]
    const response = translateGoogleToAnthropic(
      {
        responseId: "google-msg",
        candidates: [
          { content: { role: "model", parts }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 30,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 15,
        },
      },
      "gemini-3.8-flash",
    )
    expect(response).toMatchObject({
      id: "google-msg",
      model: "gemini-3.8-flash",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 70,
        cache_read_input_tokens: 30,
        output_tokens: 25,
      },
    })
    const translated = translateAnthropicToGoogle(
      payload({
        messages: [
          { role: "user", content: "read files" },
          {
            role: "assistant",
            content: response.content as Array<
              import("~/lib/types/anthropic").AnthropicAssistantContentBlock
            >,
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call-a", content: "file a" },
              { type: "tool_result", tool_use_id: "call-b", content: "file b" },
            ],
          },
        ],
      }),
    )
    expect(translated.contents[1].parts).toEqual(parts)
    expect(translated.contents[2].parts).toEqual([
      {
        functionResponse: {
          id: "call-a",
          name: "read",
          response: { output: "file a" },
        },
      },
      {
        functionResponse: {
          id: "call-b",
          name: "read",
          response: { output: "file b" },
        },
      },
    ])
  })

  test("preserves thinking text without forwarding foreign or malformed signatures", () => {
    const signatures = [
      "",
      "foreign",
      "google:not-json",
      "google:" + Buffer.from("null").toString("base64url"),
      "google:"
        + Buffer.from('{"target":"unknown","signature":"x"}').toString(
          "base64url",
        ),
      "google:"
        + Buffer.from('{"target":{"toolUseId":42},"signature":"x"}').toString(
          "base64url",
        ),
      "google:"
        + Buffer.from('{"target":{"toolUseId":""},"signature":"x"}').toString(
          "base64url",
        ),
      "google:"
        + Buffer.from('{"target":"thinking","signature":42}').toString(
          "base64url",
        ),
    ]
    const thinking: Array<AnthropicThinkingBlock> = signatures.map(
      (signature) => ({ type: "thinking", thinking: "hidden", signature }),
    )
    const translated = translateAnthropicToGoogle(
      payload({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "",
                signature: encodeGoogleSignature("orphan", "previous"),
              },
              ...thinking,
              { type: "thinking", thinking: "", signature: "" },
              { type: "text", text: "visible" },
            ],
          },
        ],
      }),
    )
    expect(translated.contents).toEqual([
      {
        role: "model",
        parts: [
          ...signatures.map(() => ({ text: "hidden", thought: true })),
          { text: "visible" },
        ],
      },
    ])
  })

  test("binds tool signatures by ID across separately stored assistant blocks", () => {
    const translated = translateAnthropicToGoogle(
      payload({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "Plan",
                signature: encodeGoogleSignature("sig-a", {
                  toolUseId: "call-a",
                }),
              },
              {
                type: "thinking",
                thinking: "",
                signature: encodeGoogleSignature("sig-b", {
                  toolUseId: "call-b",
                }),
              },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-b", name: "read", input: {} },
              { type: "text", text: "Checking files" },
              { type: "tool_use", id: "call-a", name: "read", input: {} },
            ],
          },
        ],
      }),
    )
    expect(translated.contents).toEqual([
      {
        role: "model",
        parts: [
          { text: "Plan", thought: true },
          {
            functionCall: { id: "call-b", name: "read", args: {} },
            thoughtSignature: "sig-b",
          },
          { text: "Checking files" },
          {
            functionCall: { id: "call-a", name: "read", args: {} },
            thoughtSignature: "sig-a",
          },
        ],
      },
    ])
  })

  test("restores tool signatures from existing histories using previous-part carriers", () => {
    const translated = translateAnthropicToGoogle(
      payload({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Plan", signature: "" },
              { type: "tool_use", id: "call-a", name: "read", input: {} },
              {
                type: "thinking",
                thinking: "",
                signature: encodeGoogleSignature("tool-sig", "previous"),
              },
            ],
          },
        ],
      }),
    )
    expect(translated.contents[0].parts).toEqual([
      { text: "Plan", thought: true },
      {
        functionCall: { id: "call-a", name: "read", args: {} },
        thoughtSignature: "tool-sig",
      },
    ])
  })
})

describe("Google responses and usage", () => {
  test.each([false, true])(
    "places tool signatures before tool calls and preserves thinking with upstream IDs=%s",
    (hasId) => {
      const response = translateGoogleToAnthropic(
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Plan", thought: true },
                  {
                    functionCall: {
                      ...(hasId && { id: "call-a" }),
                      name: "read",
                      args: { path: "a" },
                    },
                    thoughtSignature: "tool-sig",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
        "gemini",
      )
      expect(response.content).toHaveLength(2)
      const [thinking, tool] = response.content
      expect(thinking).toMatchObject({ type: "thinking", thinking: "Plan" })
      expect(tool).toMatchObject({ type: "tool_use", name: "read" })
      if (tool.type !== "tool_use") throw new Error("Expected tool_use")
      if (hasId) expect(tool.id).toBe("call-a")
      else expect(tool.id).toStartWith("toolu_")
      const restored = translateAnthropicToGoogle(
        payload({
          messages: [
            {
              role: "assistant",
              content: response.content as Array<
                import("~/lib/types/anthropic").AnthropicAssistantContentBlock
              >,
            },
          ],
        }),
      )
      expect(restored.contents[0].parts).toEqual([
        { text: "Plan", thought: true },
        {
          functionCall: { id: tool.id, name: "read", args: { path: "a" } },
          thoughtSignature: "tool-sig",
        },
      ])
    },
  )

  test("handles missing IDs, empty function arguments and unsigned thinking", () => {
    const response = translateGoogleToAnthropic(
      {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "Plan" },
                { functionCall: { name: "read" } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
      "gemini",
    )
    expect(response.id).toStartWith("msg_")
    expect(response.content[0]).toEqual({
      type: "thinking",
      thinking: "Plan",
      signature: "",
    })
    expect(response.content[1]).toMatchObject({
      type: "tool_use",
      input: {},
      name: "read",
    })
    expect(response.content[1]).toHaveProperty(
      "id",
      expect.stringMatching(/^toolu_/u),
    )
  })
  test("distinguishes normal completion, length, refusal, and upstream failures", () => {
    expect(getGoogleStopReason("STOP", false)).toBe("end_turn")
    expect(getGoogleStopReason("MAX_TOKENS", true)).toBe("max_tokens")
    expect(getGoogleStopReason("SAFETY", false)).toBe("refusal")
    expect(
      translateGoogleToAnthropic(
        { promptFeedback: { blockReason: "SAFETY" } },
        "gemini",
      ),
    ).toMatchObject({ content: [], stop_reason: "refusal" })
    expect(() => getGoogleStopReason("MALFORMED_FUNCTION_CALL", false)).toThrow(
      "finish reason",
    )
    expect(() => translateGoogleToAnthropic({}, "gemini")).toThrow("missing")
    expect(() =>
      translateGoogleToAnthropic(
        { error: { message: "quota exceeded" } },
        "gemini",
      ),
    ).toThrow("quota exceeded")
    expect(() => translateGoogleToAnthropic({ error: {} }, "gemini")).toThrow(
      "generation failed",
    )
  })
  test("does not double-count cached input or omit thinking output", () => {
    expect(translateGoogleUsage()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(
      translateGoogleUsage({
        promptTokenCount: 10,
        cachedContentTokenCount: 20,
        thoughtsTokenCount: 5,
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 5,
      cache_read_input_tokens: 20,
    })
  })
})
