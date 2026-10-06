import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

import { state } from "~/lib/state"
import {
  buildAnthropicBetaHeader,
  createMessages,
} from "~/services/copilot/create-messages"

test("forwards the extended-cache-ttl beta requested by the client", () => {
  const header = buildAnthropicBetaHeader(
    "extended-cache-ttl-2025-04-11",
    undefined,
    "claude-sonnet-5",
  )

  expect(header).toBe("extended-cache-ttl-2025-04-11")
})

test("keeps only allowlisted betas and drops unknown ones", () => {
  const header = buildAnthropicBetaHeader(
    "extended-cache-ttl-2025-04-11,some-unsupported-beta-2099-01-01",
    undefined,
    "claude-sonnet-5",
  )

  expect(header).toBe("extended-cache-ttl-2025-04-11")
})

test("returns undefined when the client sends no allowlisted beta", () => {
  const header = buildAnthropicBetaHeader(
    "some-unsupported-beta-2099-01-01",
    undefined,
    "claude-sonnet-5",
  )

  expect(header).toBeUndefined()
})

test("trims beta values and preserves existing allowlisted betas", () => {
  expect(
    buildAnthropicBetaHeader(
      " , extended-cache-ttl-2025-04-11, interleaved-thinking-2025-05-14, context-management-2025-06-27, advanced-tool-use-2025-11-20, ",
      undefined,
      "claude-sonnet-5",
    ),
  ).toBe(
    "extended-cache-ttl-2025-04-11,interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20",
  )
})

test("does not enable extended caching when the client sends no beta", () => {
  expect(
    buildAnthropicBetaHeader(undefined, undefined, "claude-sonnet-5"),
  ).toBeUndefined()
  expect(
    buildAnthropicBetaHeader("", undefined, "claude-sonnet-5"),
  ).toBeUndefined()
})

test("keeps the existing thinking beta default without enabling extended caching", () => {
  expect(
    buildAnthropicBetaHeader(
      undefined,
      { type: "enabled", budget_tokens: 1024 },
      "claude-sonnet-5",
    ),
  ).toBe("interleaved-thinking-2025-05-14")
  expect(
    buildAnthropicBetaHeader(
      undefined,
      { type: "adaptive" },
      "claude-sonnet-5",
    ),
  ).toBeUndefined()
})

describe("Copilot Messages prompt cache forwarding", () => {
  const originalFetch = globalThis.fetch
  const originalCopilotToken = state.copilotToken

  const fetchMock = mock((_input: string, _init?: RequestInit) =>
    Promise.resolve(
      Response.json({
        id: "msg-cache-test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ),
  )

  beforeEach(() => {
    state.copilotToken = "test-copilot-token"
    fetchMock.mockClear()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    state.copilotToken = originalCopilotToken
  })

  test("uses an explicit initiator instead of inferring it from the last message", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }

    await createMessages(payload, undefined, { requestId: "1" })
    await createMessages(payload, undefined, {
      requestId: "1",
      initiator: "agent",
    })

    const initiators = fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)["x-initiator"],
    )
    expect(initiators).toEqual(["user", "agent"])
  })

  test("forwards the cache beta and one-hour cache control blocks upstream", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-5",
      max_tokens: 16,
      system: [
        {
          type: "text",
          text: "You are a helpful assistant.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    }

    await createMessages(
      payload,
      "extended-cache-ttl-2025-04-11,unknown-beta",
      { requestId: "request-cache-test" },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toEndWith("/v1/messages")
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
      "extended-cache-ttl-2025-04-11",
    )
    expect(init?.body).toBe(JSON.stringify(payload))
  })

  test("does not add a cache beta or TTL when the client has not opted in", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-5",
      max_tokens: 16,
      system: [
        {
          type: "text",
          text: "You are a helpful assistant.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    }

    await createMessages(payload, undefined, {
      requestId: "request-cache-test",
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init?.headers).has("anthropic-beta")).toBe(false)
    expect(init?.body).toBe(JSON.stringify(payload))
  })
})
