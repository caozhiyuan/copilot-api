import { describe, expect, test } from "bun:test"

import type { AnthropicResponse } from "~/lib/types/anthropic"
import type { GoogleGenerateContentRequest } from "~/lib/types/google"
import { encodeGoogleSignature } from "~/routes/messages/google-translation"
import { encodeAntigravitySignatures } from "~/routes/google/antigravity-signatures"
import {
  translateMessagesStreamToGoogle,
  type MessagesStreamChunk,
} from "~/routes/google/messages-stream-translation"
import {
  createGoogleErrorPayload,
  decodeSignatureFromGoogle,
  encodeSignatureForGoogle,
  GoogleMessagesTranslationError,
  mapAnthropicStopReasonToGoogle,
  normalizeGeminiSchema,
  translateAnthropicResponseToGoogle,
  translateAnthropicUsageToGoogle,
  translateGoogleToMessages,
} from "~/routes/google/messages-translation"

function toAsyncIterable<T>(items: Array<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: () =>
          index < items.length ?
            Promise.resolve({ done: false as const, value: items[index++] })
          : Promise.resolve({ done: true as const, value: undefined }),
      }
    },
  }
}

async function collectStream(
  chunks: Array<MessagesStreamChunk>,
  fallbackModel = "gemini-4-neon",
) {
  const results = []
  for await (const chunk of translateMessagesStreamToGoogle(
    toAsyncIterable(chunks),
    { fallbackModel },
  )) {
    results.push(chunk)
  }
  return results
}

describe("thoughtSignature codec", () => {
  test("passes canonical base64 signatures through unchanged", () => {
    const raw = Buffer.from("gemini-4-neon-opaque-token").toString("base64")
    const encoded = encodeSignatureForGoogle(raw)
    expect(encoded).toEqual({ signature: raw })
    expect(decodeSignatureFromGoogle(encoded.signature)).toBe(raw)
  })

  test("bijectively wraps and unwraps non-base64 signatures (e.g. Responses id@encrypted)", () => {
    const raw = "rs_abc123@gAAAAABp-encrypted_payload_with_underscores"
    const encoded = encodeSignatureForGoogle(raw)
    expect(encoded.signature).not.toBe(raw)
    expect(encoded.signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u)
    expect(decodeSignatureFromGoogle(encoded.signature)).toBe(raw)
  })

  test("round-trips base64 signatures whose decoded bytes begin with the wrapper prefix", () => {
    const tricky = Buffer.from("copilot-api:sig:inner", "utf8").toString(
      "base64",
    )
    const encoded = encodeSignatureForGoogle(tricky)
    expect(encoded.signature).not.toBe(tricky)
    expect(decodeSignatureFromGoogle(encoded.signature)).toBe(tricky)
  })

  test("unwraps google:-prefixed upstream signatures with their target", () => {
    const wrapped = encodeGoogleSignature("raw-google-sig", {
      toolUseId: "toolu_1",
    })
    expect(encodeSignatureForGoogle(wrapped)).toEqual({
      signature: "raw-google-sig",
      target: { toolUseId: "toolu_1" },
    })
  })

  test("passes non-base64 incoming dummy signatures through untouched", () => {
    expect(decodeSignatureFromGoogle("skip_thought_signature_validator")).toBe(
      "skip_thought_signature_validator",
    )
  })
})

describe("normalizeGeminiSchema", () => {
  test("lowercases Gemini OpenAPI types, handles nullable, and recurses", () => {
    const normalized = normalizeGeminiSchema({
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "File path" },
        count: { type: "INTEGER", nullable: true },
        ratio: { type: "NUMBER", nullable: false },
        tags: { type: "ARRAY", items: { type: "STRING" } },
        unknown: { type: "TYPE_UNSPECIFIED" },
        meta: {
          type: "OBJECT",
          additionalProperties: { type: "BOOLEAN" },
        },
        union: { anyOf: [{ type: "STRING" }, { type: "NULL" }] },
      },
      $defs: {
        Entry: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } } },
      },
      required: ["path"],
    })

    expect(normalized).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        count: { type: ["integer", "null"] },
        ratio: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        unknown: {},
        meta: {
          type: "object",
          additionalProperties: { type: "boolean" },
        },
        union: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      $defs: {
        Entry: { type: "object", properties: { ok: { type: "boolean" } } },
      },
      required: ["path"],
    })
  })
})

describe("translateGoogleToMessages", () => {
  test("translates system instruction, multi-turn history, thoughts, signatures, and tool calls/results", () => {
    const sig = Buffer.from("sig-step-1").toString("base64")
    const request: GoogleGenerateContentRequest = {
      systemInstruction: {
        parts: [{ text: "You are a helpful coding agent." }],
      },
      contents: [
        { role: "user", parts: [{ text: "Inspect README.md" }] },
        {
          role: "model",
          parts: [
            { text: "Need to read README.md first.", thought: true },
            {
              functionCall: {
                id: "call_1",
                name: "read_file",
                args: { path: "README.md" },
              },
              thoughtSignature: sig,
            },
            {
              functionCall: {
                id: "call_2",
                name: "read_file",
                args: { path: "package.json" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            { text: "Also summarize dependencies." },
            {
              functionResponse: {
                id: "call_1",
                name: "read_file",
                response: { output: "# Copilot API" },
              },
            },
            {
              functionResponse: {
                id: "call_2",
                name: "read_file",
                response: { error: "ENOENT" },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "Read a file from disk",
              parameters: {
                type: "OBJECT",
                properties: { path: { type: "STRING" } },
                required: ["path"],
              },
            },
          ],
        },
        { googleSearch: {} },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        stopSequences: ["END"],
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "HIGH",
        },
      },
    }

    const translated = translateGoogleToMessages(request, {
      model: "gemini-4-neon",
      stream: true,
    })

    expect(translated.model).toBe("gemini-4-neon")
    expect(translated.stream).toBe(true)
    expect(translated.max_tokens).toBe(4096)
    expect(translated.temperature).toBe(0.2)
    expect(translated.top_p).toBe(0.9)
    expect(translated.top_k).toBe(40)
    expect(translated.stop_sequences).toEqual(["END"])
    expect(translated.output_config).toEqual({ effort: "high" })
    expect(translated.system).toEqual([
      { type: "text", text: "You are a helpful coding agent." },
    ])
    expect(translated.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file from disk",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ])
    expect(translated.tool_choice).toEqual({ type: "auto" })

    expect(translated.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Inspect README.md" }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Need to read README.md first.",
            signature: sig,
          },
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "README.md" },
          },
          {
            type: "tool_use",
            id: "call_2",
            name: "read_file",
            input: { path: "package.json" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "# Copilot API",
          },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: "ENOENT",
            is_error: true,
          },
          { type: "text", text: "Also summarize dependencies." },
        ],
      },
    ])
  })

  test("pairs functionCall and functionResponse by FIFO name when ids are omitted", () => {
    const request: GoogleGenerateContentRequest = {
      contents: [
        { role: "user", parts: [{ text: "Check weather" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "weather", args: { city: "NYC" } } },
            { functionCall: { name: "weather", args: { city: "SFO" } } },
          ],
        },
        {
          role: "function",
          parts: [
            {
              functionResponse: {
                name: "weather",
                response: { result: "72F" },
              },
            },
            {
              functionResponse: {
                name: "weather",
                response: { temp: 65, unit: "F" },
              },
            },
          ],
        },
      ],
    }

    const translated = translateGoogleToMessages(request, {
      model: "gemini-4-neon",
      stream: false,
    })

    const assistant = translated.messages[1]
    const user = translated.messages[2]
    expect(assistant?.role).toBe("assistant")
    expect(user?.role).toBe("user")
    if (
      assistant?.role === "assistant"
      && Array.isArray(assistant.content)
      && user?.role === "user"
      && Array.isArray(user.content)
    ) {
      const toolUses = assistant.content.filter((b) => b.type === "tool_use")
      const toolResults = user.content.filter((b) => b.type === "tool_result")
      expect(toolUses).toHaveLength(2)
      expect(toolResults).toHaveLength(2)
      expect(toolResults[0]?.tool_use_id).toBe(toolUses[0]?.id)
      expect(toolResults[0]?.content).toBe("72F")
      expect(toolResults[1]?.tool_use_id).toBe(toolUses[1]?.id)
      expect(toolResults[1]?.content).toBe('{"temp":65,"unit":"F"}')
    }
  })

  test("preserves empty-text trailing thoughtSignature parts and merges consecutive same-role turns", () => {
    const sig = Buffer.from("trailing-sig").toString("base64")
    const request: GoogleGenerateContentRequest = {
      systemInstruction: { parts: [{ text: "System instruction" }] },
      contents: [
        { role: "system", parts: [{ text: "Inline system" }] },
        { parts: [{ text: "Part 1" }] },
        { role: "user", parts: [{ text: "Part 2" }] },
        { role: "model", parts: [{ text: "Answer" }] },
        { role: "model", parts: [{ text: "", thoughtSignature: sig }] },
      ],
    }

    const translated = translateGoogleToMessages(request, {
      model: "gemini-4-neon",
      stream: false,
    })

    expect(translated.system).toEqual([
      { type: "text", text: "System instruction" },
      { type: "text", text: "Inline system" },
    ])
    expect(translated.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: sig },
          { type: "text", text: "Answer" },
        ],
      },
    ])
  })

  test("translates inlineData images, PDFs, text, fileData, and multimodal functionResponse parts", () => {
    const request: GoogleGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpg", data: "aW1n" } },
            {
              inlineData: {
                mimeType: "application/pdf",
                data: "cGRm",
                displayName: "spec.pdf",
              },
            },
            {
              inlineData: {
                mimeType: "text/plain",
                data: Buffer.from("hello txt").toString("base64"),
              },
            },
            {
              inlineData: {
                mimeType: "application/octet-stream",
                data: "AA==",
              },
            },
            { fileData: { fileUri: "gs://bucket/file.txt" } },
          ],
        },
        {
          role: "model",
          parts: [{ functionCall: { id: "c1", name: "screenshot", args: {} } }],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "c1",
                name: "screenshot",
                response: { output: "captured" },
                parts: [
                  { inlineData: { mimeType: "image/png", data: "cG5n" } },
                ],
              },
            },
          ],
        },
      ],
    }

    const translated = translateGoogleToMessages(request, {
      model: "gemini-4-neon",
      stream: false,
    })

    expect(translated.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "aW1n" },
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "cGRm",
          },
          title: "spec.pdf",
        },
        { type: "text", text: "hello txt" },
        {
          type: "text",
          text: "[Unsupported inline attachment (application/octet-stream)]",
        },
        { type: "text", text: "[File reference: gs://bucket/file.txt]" },
      ],
    })

    expect(translated.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: [
            { type: "text", text: "captured" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "cG5n" },
            },
          ],
        },
      ],
    })
  })

  test("translates toolConfig modes, allowedFunctionNames, thinkingBudget, and JSON output schema", () => {
    const baseTools = [
      {
        functionDeclarations: [
          {
            name: "alpha",
            parametersJsonSchema: { type: "object" },
          },
          {
            name: "beta",
            parametersJsonSchema: { type: "object", properties: {} },
          },
        ],
      },
    ]

    const forcedSingle = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: baseTools,
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["alpha"],
          },
        },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { ok: { type: "BOOLEAN" } },
          },
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      { model: "gemini-4-neon", stream: false },
    )

    expect(forcedSingle.tool_choice).toEqual({ type: "tool", name: "alpha" })
    expect(forcedSingle.thinking).toEqual({ type: "disabled" })
    expect(forcedSingle.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    })
    expect(forcedSingle.tools?.[0]?.input_schema).toEqual({
      type: "object",
      properties: {},
    })

    const forcedMulti = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: baseTools,
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["alpha", "beta"],
          },
        },
        generationConfig: {
          thinkingConfig: { thinkingBudget: 20000, thinkingLevel: "MINIMAL" },
        },
      },
      { model: "gemini-4-neon", stream: false },
    )

    expect(forcedMulti.tool_choice).toEqual({ type: "any" })
    expect(forcedMulti.thinking).toEqual({
      type: "enabled",
      budget_tokens: 20000,
    })
    expect(forcedMulti.max_tokens).toBeGreaterThan(20000)
    expect(forcedMulti.output_config).toEqual({ effort: "low" })

    const validatedSingle = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: baseTools,
        toolConfig: {
          functionCallingConfig: {
            mode: "VALIDATED",
            allowedFunctionNames: ["alpha"],
          },
        },
      },
      { model: "gemini-4-neon", stream: false },
    )
    expect(validatedSingle.tool_choice).toEqual({ type: "auto" })
    expect(validatedSingle.tools?.map((tool) => tool.name)).toEqual(["alpha"])

    const validatedMulti = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: baseTools,
        toolConfig: {
          functionCallingConfig: {
            mode: "VALIDATED",
            allowedFunctionNames: ["alpha", "beta"],
          },
        },
      },
      { model: "gemini-4-neon", stream: false },
    )
    expect(validatedMulti.tool_choice).toEqual({ type: "auto" })
    expect(validatedMulti.tools?.map((tool) => tool.name)).toEqual([
      "alpha",
      "beta",
    ])

    const noneChoice = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: baseTools,
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
        generationConfig: {
          thinkingConfig: { thinkingLevel: "XHIGH" },
        },
      },
      { model: "gemini-4-neon", stream: false },
    )
    expect(noneChoice.tool_choice).toEqual({ type: "none" })
    expect(noneChoice.output_config).toEqual({ effort: "xhigh" })
  })

  test("throws 400 translation errors for invalid or empty contents", () => {
    expect(() =>
      translateGoogleToMessages(
        null as unknown as GoogleGenerateContentRequest,
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)

    expect(() =>
      translateGoogleToMessages(
        { contents: [] },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)

    expect(() =>
      translateGoogleToMessages(
        { contents: [{ role: "user", parts: [{ text: "" }] }] },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)

    expect(() =>
      translateGoogleToMessages(
        {
          contents: [
            {
              role: "user",
              parts: [{ inlineData: { mimeType: "", data: "aW1n" } }],
            },
          ],
        },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)
  })
})

describe("translateAnthropicResponseToGoogle", () => {
  test("attaches thoughtSignature to first functionCall for Gemini 4 parallel tool calls", () => {
    const sig = Buffer.from("gemini-thought-sig").toString("base64")
    const response: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "gemini-4-neon",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [
        { type: "thinking", thinking: "Step 1", signature: sig },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "a.ts" },
        },
        {
          type: "tool_use",
          id: "call_2",
          name: "read_file",
          input: { path: "b.ts" },
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 25,
        cache_creation_input_tokens: 5,
      },
    }

    const translated = translateAnthropicResponseToGoogle(
      response,
      "fallback-model",
    )

    expect(translated).toEqual({
      responseId: "msg_1",
      modelVersion: "gemini-4-neon",
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [
              { text: "Step 1", thought: true },
              {
                functionCall: {
                  id: "call_1",
                  name: "read_file",
                  args: { path: "a.ts" },
                },
                thoughtSignature: sig,
              },
              {
                functionCall: {
                  id: "call_2",
                  name: "read_file",
                  args: { path: "b.ts" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 130,
        candidatesTokenCount: 40,
        cachedContentTokenCount: 25,
        totalTokenCount: 170,
      },
    })
  })

  test("attaches thoughtSignature to last part when there are no tool calls and maps finish reasons", () => {
    const sig = Buffer.from("text-sig").toString("base64")
    const response: AnthropicResponse = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "",
      stop_reason: "max_tokens",
      stop_sequence: null,
      content: [
        { type: "thinking", thinking: "", signature: sig },
        { type: "text", text: "Partial answer" },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    }

    const translated = translateAnthropicResponseToGoogle(
      response,
      "gemini-4-neon",
    )

    expect(translated.modelVersion).toBe("gemini-4-neon")
    expect(translated.candidates?.[0]).toEqual({
      index: 0,
      content: {
        role: "model",
        parts: [{ text: "Partial answer", thoughtSignature: sig }],
      },
      finishReason: "MAX_TOKENS",
    })
    expect(mapAnthropicStopReasonToGoogle("refusal")).toBe("SAFETY")
    expect(translateAnthropicUsageToGoogle(undefined)).toBeUndefined()
    expect(createGoogleErrorPayload(429, "slow down")).toEqual({
      error: { code: 429, message: "slow down", status: "RESOURCE_EXHAUSTED" },
    })
  })

  test("preserves empty-text signature part when response only contains a signature", () => {
    const sig = Buffer.from("only-sig").toString("base64")
    const translated = translateAnthropicResponseToGoogle(
      {
        id: "msg_3",
        type: "message",
        role: "assistant",
        model: "gemini-4-neon",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [{ type: "thinking", thinking: "", signature: sig }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
      "gemini-4-neon",
    )

    expect(translated.candidates?.[0]?.content?.parts).toEqual([
      { text: "", thoughtSignature: sig },
    ])
  })
})

describe("translateMessagesStreamToGoogle", () => {
  test("streams thinking deltas and attaches signature from a separate thinking block onto the first functionCall", async () => {
    const sig = Buffer.from("copilot-gemini-ro").toString("base64")
    const events: Array<MessagesStreamChunk> = [
      {
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_stream_1",
            type: "message",
            role: "assistant",
            model: "gemini-4-neon",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 50, output_tokens: 0 },
          },
        }),
      },
      { data: JSON.stringify({ type: "ping" }) },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Checking files..." },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "" },
        }),
      },
      {
        data: JSON.stringify({ type: "content_block_stop", index: 0 }),
      },
      // Copilot chat completions stream emits reasoning_opaque in a signature-only block right before tool_calls
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "signature_delta", signature: sig },
        }),
      },
      {
        data: JSON.stringify({ type: "content_block_stop", index: 1 }),
      },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
        }),
      },
      {
        data: JSON.stringify({ type: "content_block_stop", index: 2 }),
      },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "tool_use",
            id: "call_2",
            name: "list_dir",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({ type: "content_block_stop", index: 3 }),
      },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { input_tokens: 50, output_tokens: 18 },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ]

    const chunks = await collectStream(events)

    expect(chunks).toEqual([
      {
        responseId: "msg_stream_1",
        modelVersion: "gemini-4-neon",
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [{ text: "Checking files...", thought: true }],
            },
          },
        ],
      },
      {
        responseId: "msg_stream_1",
        modelVersion: "gemini-4-neon",
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call_1",
                    name: "read_file",
                    args: { path: "a.ts" },
                  },
                  thoughtSignature: sig,
                },
              ],
            },
          },
        ],
      },
      {
        responseId: "msg_stream_1",
        modelVersion: "gemini-4-neon",
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call_2",
                    name: "list_dir",
                    args: {},
                  },
                },
              ],
            },
          },
        ],
      },
      {
        responseId: "msg_stream_1",
        modelVersion: "gemini-4-neon",
        candidates: [{ index: 0, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 18,
          totalTokenCount: 68,
        },
      },
    ])
  })

  test("emits unconsumed thoughtSignature on empty text part in the final text-only chunk", async () => {
    const rawResponsesSig = "rs_99@encrypted_blob"
    const chunks = await collectStream([
      {
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_text",
            type: "message",
            role: "assistant",
            model: "gpt-5.4",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_read_input_tokens: 4,
            },
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: rawResponsesSig },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Hello!" },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 7 },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ])

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([
      { text: "Hello!" },
    ])
    const finalPart = chunks[1]?.candidates?.[0]?.content?.parts?.[0]
    expect(finalPart?.text).toBe("")
    expect(finalPart?.thoughtSignature).toBeDefined()
    expect(decodeSignatureFromGoogle(finalPart?.thoughtSignature ?? "")).toBe(
      rawResponsesSig,
    )
    expect(chunks[1]?.usageMetadata).toEqual({
      promptTokenCount: 16,
      candidatesTokenCount: 7,
      cachedContentTokenCount: 4,
      totalTokenCount: 23,
    })
  })

  test("surfaces stream errors, empty streams, and truncated streams as Google error chunks", async () => {
    const errorEvent = await collectStream([
      {
        data: JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "Upstream failure" },
        }),
      },
    ])
    expect(errorEvent).toEqual([
      { error: { code: 502, message: "Upstream failure", status: "INTERNAL" } },
    ])

    const emptyStream = await collectStream([])
    expect(emptyStream[0]?.error?.message).toContain("empty stream")

    const truncatedStream = await collectStream([
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "partial" },
        }),
      },
    ])
    expect(truncatedStream).toHaveLength(2)
    expect(truncatedStream[1]?.error?.message).toContain("message_stop")

    const invalidJson = await collectStream([{ data: "not-json" }])
    expect(invalidJson[0]?.error?.code).toBe(502)

    const invalidToolArgs = await collectStream([
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "t1",
            name: "fn",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{broken" },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
    ])
    expect(invalidToolArgs[0]?.error?.message).toContain("tool call arguments")
  })

  test("exits cleanly without yielding synthetic 502 errors when signal is aborted", async () => {
    const controller = new AbortController()
    const chunks: Array<MessagesStreamChunk> = [
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "partial" },
        }),
      },
    ]

    const earlyEofResults = []
    for await (const chunk of translateMessagesStreamToGoogle(
      toAsyncIterable(chunks),
      { fallbackModel: "gemini-4-neon", signal: controller.signal },
    )) {
      earlyEofResults.push(chunk)
      controller.abort()
    }
    expect(earlyEofResults).toHaveLength(1)
    expect(earlyEofResults[0]?.error).toBeUndefined()

    const throwingController = new AbortController()
    const throwingIterable: AsyncIterable<MessagesStreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            throwingController.abort()
            const error = new Error("Aborted")
            error.name = "AbortError"
            return Promise.reject(error)
          },
        }
      },
    }
    const thrownResults = []
    for await (const chunk of translateMessagesStreamToGoogle(
      throwingIterable,
      { fallbackModel: "gemini-4-neon", signal: throwingController.signal },
    )) {
      thrownResults.push(chunk)
    }
    expect(thrownResults).toEqual([])
  })

  test("preserves multiple Responses reasoning segments in order across SSE stream round-trips", async () => {
    const sig1 = "enc_1@rs_1"
    const sig2 = "enc_2@rs_2"

    // 1) Two consecutive reasoning items (with summaries) + text
    const consecutiveChunks = await collectStream(
      [
        {
          data: JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_multi_1",
              type: "message",
              role: "assistant",
              model: "gpt-5.4",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Step 1" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: sig1 },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 1,
            content_block: { type: "thinking", thinking: "" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 1,
            delta: { type: "thinking_delta", thinking: "Step 2" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 1,
            delta: { type: "signature_delta", signature: sig2 },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 2,
            content_block: { type: "text", text: "" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 2,
            delta: { type: "text_delta", text: "Final answer" },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 2 }) },
        {
          data: JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 12 },
          }),
        },
        { data: JSON.stringify({ type: "message_stop" }) },
      ],
      "gpt-5.4",
    )

    const reassembledParts = consecutiveChunks.flatMap(
      (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
    )
    const roundTripped = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Solve this" }] },
          { role: "model", parts: reassembledParts },
          { role: "user", parts: [{ text: "Next" }] },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(roundTripped.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Step 1", signature: sig1 },
        { type: "thinking", thinking: "Step 2", signature: sig2 },
        { type: "text", text: "Final answer" },
      ],
    })

    // 2) Two consecutive signature-only reasoning items (no summaries) + tool call
    const silentChunks = await collectStream(
      [
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: sig1 },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 1,
            content_block: { type: "thinking", thinking: "" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 1,
            delta: { type: "signature_delta", signature: sig2 },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "tool_use",
              id: "call_1",
              name: "read_file",
              input: {},
            },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 2,
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"a.ts"}',
            },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 2 }) },
        {
          data: JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
          }),
        },
        { data: JSON.stringify({ type: "message_stop" }) },
      ],
      "gpt-5.4",
    )

    const silentParts = silentChunks.flatMap(
      (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
    )
    const silentRoundTrip = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Check file" }] },
          { role: "model", parts: silentParts },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(silentRoundTrip.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: sig1 },
        { type: "thinking", thinking: "", signature: sig2 },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    })

    // 3) Interleaved reasoning -> tool_use -> reasoning -> tool_use
    const interleavedChunks = await collectStream(
      [
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "Plan A" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: sig1 },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "call_1",
              name: "read_file",
              input: { path: "a.ts" },
            },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 2,
            content_block: { type: "thinking", thinking: "Plan B" },
          }),
        },
        {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 2,
            delta: { type: "signature_delta", signature: sig2 },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 2 }) },
        {
          data: JSON.stringify({
            type: "content_block_start",
            index: 3,
            content_block: {
              type: "tool_use",
              id: "call_2",
              name: "read_file",
              input: { path: "b.ts" },
            },
          }),
        },
        { data: JSON.stringify({ type: "content_block_stop", index: 3 }) },
        {
          data: JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
          }),
        },
        { data: JSON.stringify({ type: "message_stop" }) },
      ],
      "gpt-5.4",
    )

    const interleavedParts = interleavedChunks.flatMap(
      (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
    )
    expect(interleavedParts).toHaveLength(4)
    expect(interleavedParts[1]?.functionCall?.id).toBe("call_1")
    expect(interleavedParts[1]?.thoughtSignature).toBeDefined()
    expect(interleavedParts[3]?.functionCall?.id).toBe("call_2")
    expect(interleavedParts[3]?.thoughtSignature).toBeDefined()

    const interleavedRoundTrip = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Inspect two files" }] },
          { role: "model", parts: interleavedParts },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(interleavedRoundTrip.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Plan A", signature: sig1 },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "a.ts" },
        },
        { type: "thinking", thinking: "Plan B", signature: sig2 },
        {
          type: "tool_use",
          id: "call_2",
          name: "read_file",
          input: { path: "b.ts" },
        },
      ],
    })
  })

  test("returns MAX_TOKENS instead of 502 when streaming tool call arguments are truncated by max_tokens", async () => {
    const sig = Buffer.from("thinking-before-truncation").toString("base64")
    const truncatedChunks = await collectStream([
      {
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_trunc_1",
            type: "message",
            role: "assistant",
            model: "gemini-4-neon",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 30, output_tokens: 0 },
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: sig },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "call_big_write",
            name: "write_file",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"path":"big.ts","content":"unterminated',
          },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { output_tokens: 4096 },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ])

    expect(truncatedChunks).toEqual([
      {
        responseId: "msg_trunc_1",
        modelVersion: "gemini-4-neon",
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [{ text: "", thoughtSignature: sig }],
            },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 4096,
          totalTokenCount: 4126,
        },
      },
    ])

    // Still fails with 502 when stop_reason is NOT max_tokens
    const brokenNotMaxTokens = await collectStream([
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "call_broken",
            name: "write_file",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"broken":' },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ])
    expect(brokenNotMaxTokens[0]?.error).toMatchObject({
      code: 502,
      status: "INTERNAL",
    })
    expect(brokenNotMaxTokens[0]?.error?.message).toContain(
      "tool call arguments",
    )

    // Still fails with 502 when a subsequent non-thinking block starts after broken tool args
    const brokenFollowedByText = await collectStream([
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "call_broken",
            name: "write_file",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"broken":' },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "after" },
        }),
      },
    ])
    expect(brokenFollowedByText[0]?.error?.code).toBe(502)
  })
})

describe("Gemini request fields, responseFormat, and multi-reasoning JSON round-trip", () => {
  test("ignores unsupported Gemini request field aliases", () => {
    const rawRequest = {
      contents: [
        {
          parts: [
            {
              text: "Hello",
              inline_data: { mime_type: "image/png", data: "aW1n" },
            },
          ],
        },
      ],
      generation_config: { max_output_tokens: 42 },
    }
    const options = { model: "gemini-4-neon", stream: false }

    expect(translateGoogleToMessages(rawRequest, options)).toEqual(
      translateGoogleToMessages(
        { contents: [{ parts: [{ text: "Hello" }] }] },
        options,
      ),
    )
  })

  test("preserves user keys in tool arguments, results, and schemas", () => {
    const request: GoogleGenerateContentRequest = {
      contents: [
        { role: "user", parts: [{ text: "Inspect the file" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call_inspect_1",
                name: "inspect_file",
                args: { file_path: "src/app.ts", line_number: 10 },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call_inspect_1",
                name: "inspect_file",
                response: { exit_code: 0, raw_text: "ok" },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "inspect_file",
              description: "Inspect a file",
              parametersJsonSchema: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  line_number: { type: "integer" },
                },
                required: ["file_path"],
              },
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.3,
        topP: 0.85,
        topK: 20,
        stopSequences: ["DONE"],
        thinkingConfig: {
          thinkingBudget: 1024,
          thinkingLevel: "HIGH",
        },
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            user_id: { type: "STRING" },
            union_val: { anyOf: [{ type: "STRING" }, { type: "NULL" }] },
          },
          additionalProperties: false,
        },
      },
    }

    const translated = translateGoogleToMessages(request, {
      model: "gemini-4-neon",
      stream: false,
    })

    expect(translated.max_tokens).toBe(2048)
    expect(translated.temperature).toBe(0.3)
    expect(translated.top_p).toBe(0.85)
    expect(translated.top_k).toBe(20)
    expect(translated.stop_sequences).toEqual(["DONE"])
    expect(translated.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    })
    expect(translated.output_config).toEqual({
      effort: "high",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            user_id: { type: "string" },
            union_val: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          additionalProperties: false,
        },
      },
    })
    expect(translated.tools).toEqual([
      {
        name: "inspect_file",
        description: "Inspect a file",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            line_number: { type: "integer" },
          },
          required: ["file_path"],
        },
      },
    ])
    expect(translated.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Inspect the file" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_inspect_1",
            name: "inspect_file",
            input: { file_path: "src/app.ts", line_number: 10 },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_inspect_1",
            content: '{"exit_code":0,"raw_text":"ok"}',
          },
        ],
      },
    ])
  })

  test("translates Gemini 4+ generationConfig.responseFormat.text.schema and rejects unsupported formats", () => {
    const objectFormat = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "Extract verdict" }] }],
        generationConfig: {
          responseFormat: {
            text: {
              mimeType: "APPLICATION_JSON",
              schema: {
                title: "Verdict Result",
                type: "OBJECT",
                properties: {
                  passed: { type: "BOOLEAN" },
                  score: { type: "INTEGER", nullable: true },
                },
                required: ["passed"],
              },
            },
          },
        },
      },
      { model: "gemini-4-neon", stream: false },
    )
    expect(objectFormat.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          title: "Verdict Result",
          type: "object",
          properties: {
            passed: { type: "boolean" },
            score: { type: ["integer", "null"] },
          },
          required: ["passed"],
        },
      },
    })

    const arrayFormat = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "Extract verdict" }] }],
        generationConfig: {
          responseFormat: [
            {
              text: {
                mimeType: "application/json",
                jsonSchema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                },
              },
            },
          ],
        },
      },
      { model: "gemini-4-neon", stream: false },
    )
    expect(arrayFormat.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    })

    // Plain text responseFormat / responseMimeType passes through without error
    const plainTextFormat = translateGoogleToMessages(
      {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: {
          responseFormat: { text: { mimeType: "TEXT_PLAIN" } },
          responseMimeType: "text/plain",
        },
      },
      { model: "gemini-4-neon", stream: false },
    )
    expect(plainTextFormat.output_config).toBeUndefined()

    // Non-text responseFormat modality -> 400
    expect(() =>
      translateGoogleToMessages(
        {
          contents: [{ role: "user", parts: [{ text: "Draw" }] }],
          generationConfig: {
            responseFormat: { image: { aspectRatio: "16:9" } },
          },
        },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)

    // Schema paired with non-JSON mimeType -> 400
    expect(() =>
      translateGoogleToMessages(
        {
          contents: [{ role: "user", parts: [{ text: "Extract" }] }],
          generationConfig: {
            responseFormat: {
              text: {
                mimeType: "TEXT_PLAIN",
                schema: { type: "object" },
              },
            },
          },
        },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)

    // JSON mimeType without schema -> 400 (cannot enforce schema-free JSON via output_config)
    expect(() =>
      translateGoogleToMessages(
        {
          contents: [{ role: "user", parts: [{ text: "Return JSON" }] }],
          generationConfig: {
            responseFormat: { text: { mimeType: "APPLICATION_JSON" } },
          },
        },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)

    expect(() =>
      translateGoogleToMessages(
        {
          contents: [{ role: "user", parts: [{ text: "Return JSON" }] }],
          generationConfig: {
            responseMimeType: "application/json",
          },
        },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)

    expect(() =>
      translateGoogleToMessages(
        {
          contents: [{ role: "user", parts: [{ text: "Pick one" }] }],
          generationConfig: {
            responseMimeType: "text/x.enum",
            responseSchema: { type: "STRING", enum: ["A", "B"] },
          },
        },
        { model: "gemini-4-neon", stream: false },
      ),
    ).toThrow(GoogleMessagesTranslationError)
  })

  test("preserves multiple Responses reasoning segments and order across non-stream JSON round-trip", () => {
    const sig1 = "enc_1@rs_1"
    const sig2 = "enc_2@rs_2"

    // 1) Consecutive reasoning items + text
    const consecutive = translateAnthropicResponseToGoogle(
      {
        id: "msg_json_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [
          { type: "thinking", thinking: "Step 1", signature: sig1 },
          { type: "thinking", thinking: "Step 2", signature: sig2 },
          { type: "text", text: "Done" },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      "gpt-5.4",
    )

    const consecutiveParts = consecutive.candidates?.[0]?.content?.parts ?? []
    expect(consecutiveParts).toHaveLength(4)
    expect(consecutiveParts[0]).toEqual({ text: "Step 1", thought: true })
    expect(consecutiveParts[1]?.text).toBe("")
    expect(
      decodeSignatureFromGoogle(consecutiveParts[1]?.thoughtSignature ?? ""),
    ).toBe(sig1)
    expect(consecutiveParts[2]).toEqual({ text: "Step 2", thought: true })
    expect(consecutiveParts[3]?.text).toBe("Done")
    expect(
      decodeSignatureFromGoogle(consecutiveParts[3]?.thoughtSignature ?? ""),
    ).toBe(sig2)

    const restoredFull = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Go" }] },
          { role: "model", parts: consecutiveParts },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(restoredFull.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Step 1", signature: sig1 },
        { type: "thinking", thinking: "Step 2", signature: sig2 },
        { type: "text", text: "Done" },
      ],
    })

    // Even if a client strips thought:true parts, both signatures round-trip in order
    const restoredWithoutThoughts = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Go" }] },
          {
            role: "model",
            parts: consecutiveParts.filter((part) => !part.thought),
          },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(restoredWithoutThoughts.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: sig1 },
        { type: "thinking", thinking: "", signature: sig2 },
        { type: "text", text: "Done" },
      ],
    })

    // 2) Interleaved reasoning + tool_use + reasoning + tool_use
    const interleaved = translateAnthropicResponseToGoogle(
      {
        id: "msg_json_2",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        stop_reason: "tool_use",
        stop_sequence: null,
        content: [
          { type: "thinking", thinking: "First", signature: sig1 },
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "a.ts" },
          },
          { type: "thinking", thinking: "Second", signature: sig2 },
          {
            type: "tool_use",
            id: "call_2",
            name: "read_file",
            input: { path: "b.ts" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      "gpt-5.4",
    )

    const restoredInterleaved = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Check both" }] },
          {
            role: "model",
            parts: interleaved.candidates?.[0]?.content?.parts ?? [],
          },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(restoredInterleaved.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "First", signature: sig1 },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "a.ts" },
        },
        { type: "thinking", thinking: "Second", signature: sig2 },
        {
          type: "tool_use",
          id: "call_2",
          name: "read_file",
          input: { path: "b.ts" },
        },
      ],
    })

    // 3) Interleaved reasoning + text + reasoning + text
    const interleavedText = translateAnthropicResponseToGoogle(
      {
        id: "msg_json_3",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [
          { type: "thinking", thinking: "Draft 1", signature: sig1 },
          { type: "text", text: "Interim" },
          { type: "thinking", thinking: "Draft 2", signature: sig2 },
          { type: "text", text: "Final" },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      "gpt-5.4",
    )

    const restoredInterleavedText = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Explain" }] },
          {
            role: "model",
            parts: interleavedText.candidates?.[0]?.content?.parts ?? [],
          },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(restoredInterleavedText.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Draft 1", signature: sig1 },
        { type: "text", text: "Interim" },
        { type: "thinking", thinking: "Draft 2", signature: sig2 },
        { type: "text", text: "Final" },
      ],
    })
  })

  test("preserves per-turn Antigravity offsets across adjacent model contents and unwraps fallback spans", () => {
    const sig1 = encodeAntigravitySignatures([["enc_1@rs_1", 5, 0]])
    const sig2 = encodeAntigravitySignatures([["enc_2@rs_2", 0, 0]])

    const adjacent = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Start" }] },
          {
            role: "model",
            parts: [{ text: "Hello", thoughtSignature: sig1 }],
          },
          {
            role: "model",
            parts: [{ text: "World", thoughtSignature: sig2 }],
          },
          { role: "user", parts: [{ text: "Next" }] },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(adjacent.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "", signature: "enc_1@rs_1" },
        { type: "thinking", thinking: "", signature: "enc_2@rs_2" },
        { type: "text", text: "World" },
      ],
    })

    // Mixed agy + native signature in one span must unwrap agy envelopes instead of leaking raw base64
    const nativeSig = Buffer.from("native-opaque").toString("base64")
    const mixed = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Start" }] },
          {
            role: "model",
            parts: [
              { thought: true, text: "First thought", thoughtSignature: sig1 },
              {
                text: "Interim",
                thoughtSignature: encodeAntigravitySignatures([
                  ["enc_3@rs_3", 0, 0],
                ]),
              },
              {
                functionCall: { id: "call_1", name: "read_file", args: {} },
                thoughtSignature: nativeSig,
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_1",
                  name: "read_file",
                  response: { output: "ok" },
                },
              },
            ],
          },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(mixed.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "First thought",
          signature: "enc_1@rs_1",
        },
        { type: "thinking", thinking: "", signature: "enc_3@rs_3" },
        { type: "thinking", thinking: "", signature: nativeSig },
        { type: "text", text: "Interim" },
        { type: "tool_use", id: "call_1", name: "read_file", input: {} },
      ],
    })

    // Non-monotonic offsets inside a single content or inlineData in the span also unwrap safely
    const nonMonotonic = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Start" }] },
          {
            role: "model",
            parts: [
              { text: "Hello", thoughtSignature: sig1 },
              { text: "Again", thoughtSignature: sig2 },
            ],
          },
          { role: "user", parts: [{ text: "Next" }] },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(nonMonotonic.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "enc_1@rs_1" },
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "", signature: "enc_2@rs_2" },
        { type: "text", text: "Again" },
      ],
    })

    const withInlineData = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Start" }] },
          {
            role: "model",
            parts: [
              { text: "Result", thoughtSignature: sig1 },
              { inlineData: { mimeType: "image/png", data: "aW1n" } },
            ],
          },
          { role: "user", parts: [{ text: "Next" }] },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(withInlineData.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "enc_1@rs_1" },
        { type: "text", text: "Result" },
      ],
    })
  })

  test("encodes Antigravity offset signatures on non-stream Responses replies when preserveAntigravityReasoning is enabled", () => {
    const response = translateAnthropicResponseToGoogle(
      {
        id: "msg_agy_json",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [
          { type: "thinking", thinking: "Step 1.", signature: "enc_1@rs_1" },
          { type: "text", text: "Checking. " },
          { type: "thinking", thinking: "", signature: "enc_2@rs_2" },
          { type: "text", text: "Done." },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      "gpt-5.4",
      { preserveAntigravityReasoning: true },
    )

    const parts = response.candidates?.[0]?.content?.parts ?? []
    const sigBytes = parts.flatMap((part) =>
      part.thoughtSignature ?
        [Buffer.from(part.thoughtSignature, "base64")]
      : [],
    )
    expect(sigBytes).toHaveLength(1)

    const merged = [
      {
        thought: true,
        text: parts
          .filter((part) => part.thought)
          .map((part) => part.text)
          .join(""),
      },
      {
        text: parts
          .filter((part) => !part.thought)
          .map((part) => part.text)
          .join(""),
        thoughtSignature: Buffer.concat(sigBytes).toString("base64"),
      },
    ]

    const restored = translateGoogleToMessages(
      {
        contents: [
          { role: "user", parts: [{ text: "Run" }] },
          { role: "model", parts: merged },
          { role: "user", parts: [{ text: "Continue" }] },
        ],
      },
      { model: "gpt-5.4", stream: false },
    )
    expect(restored.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Step 1.", signature: "enc_1@rs_1" },
        { type: "text", text: "Checking. " },
        { type: "thinking", thinking: "", signature: "enc_2@rs_2" },
        { type: "text", text: "Done." },
      ],
    })
  })
})
