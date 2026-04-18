import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { prepareMessagesApiPayload } from "../src/routes/messages/preprocess"

describe("sanitizeErrorToolResults - extraction", () => {
  test("extracts image from is_error tool_result to message tail", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-err",
              is_error: true,
              content: [
                { type: "text", text: "error occurred" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "abc",
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    prepareMessagesApiPayload(payload)

    const content = payload.messages[0].content as unknown as Array<
      Record<string, unknown>
    >
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tool-err",
      is_error: true,
      content: [{ type: "text", text: "error occurred" }],
    })
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc" },
    })
  })

  test("strips tool_reference from is_error tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-ref-err",
              is_error: true,
              content: [{ type: "tool_reference", tool_name: "SomeTool" }],
            },
          ],
        },
      ],
    }

    prepareMessagesApiPayload(payload)

    const content = payload.messages[0].content as unknown as Array<
      Record<string, unknown>
    >
    expect(content).toHaveLength(1)
    expect(content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tool-ref-err",
      is_error: true,
      content: [],
    })
  })

  test("keeps tool_results contiguous and appends extracted attachments to tail", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-err-1",
              is_error: true,
              content: [
                { type: "text", text: "fail" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "img1",
                  },
                },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "tool-ok",
              content: "success",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-err-2",
              is_error: true,
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "pdf1",
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    prepareMessagesApiPayload(payload)

    const content = payload.messages[0].content as unknown as Array<
      Record<string, unknown>
    >
    expect(content).toHaveLength(5)
    expect(content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool-err-1",
      is_error: true,
    })
    expect(content[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool-ok",
    })
    expect(content[2]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool-err-2",
      is_error: true,
    })
    expect(content[3]).toMatchObject({ type: "image" })
    expect(content[4]).toMatchObject({ type: "document" })
  })
})

describe("sanitizeErrorToolResults - passthrough", () => {
  test("does not modify is_error tool_result with string content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-str",
              is_error: true,
              content: "plain error text",
            },
          ],
        },
      ],
    }

    prepareMessagesApiPayload(payload)

    const content = payload.messages[0].content as unknown as Array<
      Record<string, unknown>
    >
    expect(content).toHaveLength(1)
    expect(content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tool-str",
      is_error: true,
      content: "plain error text",
    })
  })

  test("does not modify non-error tool_result with image content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-ok",
              content: [
                { type: "text", text: "result" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "img",
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    prepareMessagesApiPayload(payload)

    const content = payload.messages[0].content as unknown as Array<
      Record<string, unknown>
    >
    expect(content).toHaveLength(1)
    const inner = (content[0] as { content: Array<unknown> }).content
    expect(inner).toHaveLength(2)
  })
})
