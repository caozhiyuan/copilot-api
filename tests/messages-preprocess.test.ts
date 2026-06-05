import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import {
  applyLastMessageCacheControl,
  getLastMessageContentCacheControl,
  mergeToolResultForClaude,
  normalizeSystemMessages,
  prepareMessagesApiPayload,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "../src/routes/messages/preprocess"

describe("normalizeSystemMessages", () => {
  test("merges system string content into the previous message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "hello",
        },
        {
          role: "system",
          content: "follow the repo style",
        },
        {
          role: "assistant",
          content: "working on it",
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.system).toBeUndefined()
    expect(payload.messages).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nfollow the repo style\n</system-reminder>\n\nhello",
      },
      {
        role: "assistant",
        content: "working on it",
      },
    ])
  })

  test("moves leading system messages to payload.system and appends block content to the previous array message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "system",
          content: "leading system prompt",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
            },
          ],
        },
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "follow the repo style",
            },
          ],
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.system).toBe(
      "<system-reminder>\nleading system prompt\n</system-reminder>",
    )
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nfollow the repo style\n</system-reminder>",
          },
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ])
  })

  test("inserts system text after tool_result blocks in user array content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "tool output",
            },
            {
              type: "text",
              text: "hello",
            },
          ],
        },
        {
          role: "system",
          content: "follow the repo style",
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "tool output",
          },
          {
            type: "text",
            text: "<system-reminder>\nfollow the repo style\n</system-reminder>",
          },
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ])
  })

  test("splits SubagentStart hook additional first line into its own content block", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "hello",
        },
        {
          role: "system",
          content: "SubagentStart hook additional\nextra reminder",
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nSubagentStart hook additional\n</system-reminder>",
          },
          {
            type: "text",
            text: "<system-reminder>\nextra reminder\n</system-reminder>",
          },
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ])
  })
})

describe("mergeToolResultForClaude", () => {
  test("removes tool reference turn boundaries before merging", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })

  test("restores cache_control captured before stripping Tool loaded", () => {
    const message: AnthropicMessagesPayload["messages"][number] = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
        {
          type: "text",
          text: "Tool loaded.",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        },
      ],
    }
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [message],
    }

    const lastMessageCacheControl = getLastMessageContentCacheControl(
      payload.messages.at(-1),
    )
    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)
    applyLastMessageCacheControl(payload, lastMessageCacheControl)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        },
      ],
    })
  })

  test("keeps Tool loaded text when the message has no tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "Tool loaded.",
        },
      ],
    })
  })

  test("merges text blocks into matching tool_result blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Follow-up details",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\nFollow-up details",
        },
      ],
    })
  })

  test("adds cache_control to the merged tool_result when trailing text is absorbed", () => {
    const message: AnthropicMessagesPayload["messages"][number] = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "[Pasted ~4 lines]",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    }
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [message],
    }

    const lastMessageCacheControl = getLastMessageContentCacheControl(
      payload.messages.at(-1),
    )
    mergeToolResultForClaude(payload)
    applyLastMessageCacheControl(payload, lastMessageCacheControl)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\n[Pasted ~4 lines]",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("strips cache_control from blocks absorbed into tool_result content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "text",
                  text: "existing output",
                },
              ],
            },
            {
              type: "text",
              text: "follow-up details",
              cache_control: {
                type: "ephemeral",
                scope: "user",
              },
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
              cache_control: {
                type: "ephemeral",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "existing output",
            },
            {
              type: "text",
              text: "follow-up details",
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
    })
  })

  test("appends all text blocks to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "extra one",
            },
            {
              type: "text",
              text: "extra two",
            },
            {
              type: "text",
              text: "extra three",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: "second\n\nextra one\n\nextra two\n\nextra three",
        },
      ],
    })
  })
})

describe("mergeToolResultForClaude attachments", () => {
  test("merges attachments into matching tool_result blocks when counts match", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second output",
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
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "first output",
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
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second output",
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
    })
  })

  test("appends image and document blocks to the last tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "binary output",
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
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "binary output",
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
    })
  })
})

describe("mergeToolResultForClaude attachments fallback", () => {
  test("appends all attachments to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data-1",
              },
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
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "image-data-2",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first output",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data-1",
              },
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
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "image-data-2",
              },
            },
          ],
        },
      ],
    })
  })

  test("keeps text merging and appends attachments to the last tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "text",
              text: "first detail",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "second detail",
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
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first\n\nfirst detail",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second\n\nsecond detail",
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
    })
  })
})

describe("mergeToolResultForClaude attachments with tool_reference", () => {
  test("falls back to the last tool_result without tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "binary output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
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
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "binary output",
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
          tool_use_id: "tool-2",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })
})

describe("sanitizeIdeTools", () => {
  test("continues to remove executeCode when Responses tool search is disabled", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__executeCode",
          description: "Execute code",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__getDiagnostics",
          description: "Old description",
          input_schema: { type: "object" },
        },
      ],
    }

    sanitizeIdeTools(payload)

    expect(payload.tools?.map((tool) => tool.name)).toEqual([
      "mcp__tool_search__search",
      "mcp__ide__getDiagnostics",
    ])
  })

  test("does not keep executeCode for GPT models without the tool search bridge", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "mcp__ide__executeCode",
          description: "Execute code",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__getDiagnostics",
          description: "Old description",
          input_schema: { type: "object" },
        },
      ],
    }

    sanitizeIdeTools(payload)

    expect(payload.tools?.map((tool) => tool.name)).toEqual([
      "mcp__ide__getDiagnostics",
    ])
  })
})

describe("prepareMessagesApiPayload", () => {
  test("strips cache_control scope, filters thinking blocks, and enables adaptive thinking", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        } as AnthropicMessagesPayload["system"] extends Array<infer T> ? T
        : never,
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "sig-1",
            },
            {
              type: "thinking",
              thinking: "Keep this",
              signature: "sig-2",
            },
            {
              type: "thinking",
              thinking: "Drop this too",
              signature: "bad@sig",
            },
            {
              type: "text",
              text: "Visible text",
            },
          ],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    const systemBlock = (
      payload.system as unknown as Array<Record<string, unknown>>
    )[0]
    expect(systemBlock).toEqual({
      type: "text",
      text: "system prompt",
      cache_control: {
        type: "ephemeral",
      },
    })
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Keep this",
          signature: "sig-2",
        },
        {
          type: "text",
          text: "Visible text",
        },
      ],
    })
    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
    expect(payload.output_config).toEqual({ effort: "xhigh" })
  })

  test("sets summarized display for Claude versions at least 4.7", () => {
    const models = [
      "claude-opus-4.7",
      "claude-opus-4.8",
      "claude-opus-4.10",
      "claude-opus-4-7-20260101",
      "claude-sonnet-4.7",
    ]

    for (const model of models) {
      const payload: AnthropicMessagesPayload = {
        model,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        thinking: {
          type: "enabled",
          budget_tokens: 1024,
        },
      }

      prepareMessagesApiPayload(payload, {
        capabilities: {
          supports: {
            adaptive_thinking: true,
          },
        },
      } as never)

      expect(payload.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      })
    }
  })

  test("does not force summarized display for Claude versions before 4.7", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "adaptive",
    })
  })

  test("does not enable adaptive thinking when tool choice forces tool use", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "tool",
        name: "apply_patch",
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })

  test("strips top-level cache_control sent by Zed (minimal-mode shape)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-haiku-4.5",
      max_tokens: 64000,
      cache_control: { type: "ephemeral" },
      system: [
        {
          type: "text",
          text: "You are the Zed coding agent ...",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello world!" }],
        },
      ],
    }

    prepareMessagesApiPayload(payload)

    expect(payload.cache_control).toBeUndefined()
    expect(payload.messages[0].content).toEqual([
      {
        type: "text",
        text: "Hello world!",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(
      (payload.system as unknown as Array<Record<string, unknown>>)[0]
        .cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("strips tool eager_input_streaming sent by Zed (write-mode shape)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-haiku-4.5",
      max_tokens: 64000,
      cache_control: { type: "ephemeral" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello World" }],
        },
      ],
      tools: [
        {
          name: "edit_file",
          input_schema: { type: "object" },
          eager_input_streaming: true,
        },
        {
          name: "write_file",
          input_schema: { type: "object" },
          eager_input_streaming: true,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ] as unknown as AnthropicMessagesPayload["tools"],
    }

    prepareMessagesApiPayload(payload)

    for (const tool of payload.tools ?? []) {
      expect(tool).not.toHaveProperty("eager_input_streaming")
    }
    expect(payload.tools?.[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    })
    expect(payload.cache_control).toBeUndefined()
  })
})
