import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"
import { requestContext } from "~/lib/request-context"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

const originalFetch = globalThis.fetch

let capturedHeaders: Record<string, string> | undefined

const fetchMock = mock((_input: unknown, init?: RequestInit) => {
  capturedHeaders = init?.headers as Record<string, string> | undefined
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }),
  )
})

const createProviderConfig = (
  name = "opencode-go",
): ResolvedProviderConfig => ({
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://opencode.example/zen/go",
  name,
  type: "openai-compatible",
})

const createMessagesPayload = (
  overrides: Record<string, unknown> = {},
): AnthropicMessagesPayload => ({
  max_tokens: 128,
  messages: [{ content: "hello", role: "user" }],
  model: "qwen3-coder",
  ...overrides,
})

const createChatCompletionsPayload = (
  overrides: Record<string, unknown> = {},
): ChatCompletionsPayload => ({
  messages: [{ content: "hello", role: "user" }],
  model: "kimi-k2",
  ...overrides,
})

const createResponsesPayload = (
  overrides: Record<string, unknown> = {},
): ResponsesPayload => ({
  input: "hello",
  model: "gpt-5.4",
  ...overrides,
})

const runWithContext = <T>(
  context: { rootSessionId?: string; sessionAffinity?: string },
  callback: () => T,
): T =>
  requestContext.run(
    {
      traceId: "test-trace",
      startTime: Date.now(),
      userAgent: "test-agent",
      sessionAffinity: context.sessionAffinity,
      rootSessionId: context.rootSessionId,
      parentSessionId: undefined,
    },
    callback,
  )

const runWithSessionAffinity = <T>(
  sessionAffinity: string | undefined,
  callback: () => T,
): T => runWithContext({ sessionAffinity }, callback)

const opencodeSessionHeader = (): string | undefined =>
  capturedHeaders?.["x-opencode-session"]

beforeEach(() => {
  capturedHeaders = undefined
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("opencode-go x-opencode-session header", () => {
  describe("messages", () => {
    test("prefers the root session over session affinity and metadata", async () => {
      const payload = createMessagesPayload({
        metadata: { user_id: JSON.stringify({ session_id: "ses_json" }) },
      })

      await runWithContext(
        { rootSessionId: "root-1", sessionAffinity: "affinity-1" },
        () =>
          forwardProviderMessages(
            createProviderConfig(),
            payload,
            new Headers(),
          ),
      )

      expect(opencodeSessionHeader()).toBe("root-1")
    })

    test("uses the root session when no affinity or metadata exists", async () => {
      await runWithContext({ rootSessionId: "root-1" }, () =>
        forwardProviderMessages(
          createProviderConfig(),
          createMessagesPayload(),
          new Headers(),
        ),
      )

      expect(opencodeSessionHeader()).toBe("root-1")
    })

    test("ignores a blank root session and falls back to affinity", async () => {
      await runWithContext(
        { rootSessionId: "  ", sessionAffinity: "affinity-1" },
        () =>
          forwardProviderMessages(
            createProviderConfig(),
            createMessagesPayload(),
            new Headers(),
          ),
      )

      expect(opencodeSessionHeader()).toBe("affinity-1")
    })

    test("prefers session affinity over metadata user_id", async () => {
      const payload = createMessagesPayload({
        metadata: { user_id: JSON.stringify({ session_id: "ses_json" }) },
      })

      await runWithSessionAffinity("affinity-1", () =>
        forwardProviderMessages(createProviderConfig(), payload, new Headers()),
      )

      expect(opencodeSessionHeader()).toBe("affinity-1")
    })

    test.each([
      JSON.stringify({ session_id: "ses_json" }),
      "user_abc_account_def_session_sess-legacy",
      "plain-user",
    ])("does not derive a session from metadata user_id %s", async (userId) => {
      const payload = createMessagesPayload({ metadata: { user_id: userId } })
      await forwardProviderMessages(
        createProviderConfig(),
        payload,
        new Headers(),
      )
      expect(opencodeSessionHeader()).toBeUndefined()
    })

    test("omits header without session affinity or user_id", async () => {
      await forwardProviderMessages(
        createProviderConfig(),
        createMessagesPayload(),
        new Headers(),
      )

      expect(opencodeSessionHeader()).toBeUndefined()
    })
  })

  describe("chat completions", () => {
    test("uses prompt cache key", async () => {
      const payload = createChatCompletionsPayload({
        prompt_cache_key: "cc-cache-key",
      })

      await forwardProviderChatCompletions(
        createProviderConfig(),
        payload,
        new Headers(),
      )

      expect(opencodeSessionHeader()).toBe("cc-cache-key")
    })

    test("omits header without prompt cache key", async () => {
      await forwardProviderChatCompletions(
        createProviderConfig(),
        createChatCompletionsPayload(),
        new Headers(),
      )

      expect(opencodeSessionHeader()).toBeUndefined()
    })
  })

  describe("responses", () => {
    test("uses prompt cache key", async () => {
      const payload = createResponsesPayload({
        prompt_cache_key: "responses-cache-key",
      })

      const response = await forwardProviderResponses(
        createProviderConfig(),
        payload,
        new Headers(),
      )
      await response.text()

      expect(opencodeSessionHeader()).toBe("responses-cache-key")
    })

    test("omits header without prompt cache key", async () => {
      const response = await forwardProviderResponses(
        createProviderConfig(),
        createResponsesPayload(),
        new Headers(),
      )
      await response.text()

      expect(opencodeSessionHeader()).toBeUndefined()
    })
  })

  test("does not set the header for other providers", async () => {
    const payload = createMessagesPayload({
      metadata: { user_id: JSON.stringify({ session_id: "ses_json" }) },
    })

    await runWithSessionAffinity("affinity-1", () =>
      forwardProviderMessages(
        createProviderConfig("other-provider"),
        payload,
        new Headers(),
      ),
    )

    expect(opencodeSessionHeader()).toBeUndefined()
  })
})
