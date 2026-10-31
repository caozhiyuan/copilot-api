import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createServer } from "node:http"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"

import { COMPACT_REQUEST } from "~/lib/compact"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { isAsyncIterable } from "~/lib/utils"
import { createMessages } from "~/services/copilot/create-messages"
import { getVSCodeVersion } from "~/services/get-vscode-version"

const originalFetch = globalThis.fetch
const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  githubToken: state.githubToken,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  macMachineId: state.macMachineId,
}

const responsePayload: AnthropicResponse = {
  id: "msg-headers-test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}
const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(Response.json(responsePayload)),
)
const createPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "claude-sonnet-5",
  max_tokens: 16,
  messages: [{ role: "user", content: "hello" }],
  metadata: { user_id: "user_device-1_account_account-1_session_session-1" },
  ...overrides,
})
const getRequestHeaders = (index = 0) =>
  fetchMock.mock.calls[index][1]?.headers as Record<string, string>

const getRejectedError = async (pending: Promise<unknown>): Promise<Error> => {
  try {
    await pending
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("Expected the request to fail")
}

beforeEach(async () => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL
  Object.assign(state, {
    accountType: "individual",
    copilotApiUrl: "https://api.individual.githubcopilot.com",
    githubToken: "test-github-token",
    copilotToken: "test-copilot-token",
    vsCodeVersion: await getVSCodeVersion(),
    vsCodeDeviceId: "device-1",
    vsCodeSessionId: "vscode-session-1",
    macMachineId: "machine-1",
  })
  fetchMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  }
  if (originalEnterpriseUrl === undefined) {
    delete process.env.COPILOT_API_ENTERPRISE_URL
  } else {
    process.env.COPILOT_API_ENTERPRISE_URL = originalEnterpriseUrl
  }
})

describe("Messages proxy request headers", () => {
  test("preserves custom header casing over Bun HTTP transport", async () => {
    let rawHeaders: Array<string> = []
    const server = createServer((request, response) => {
      rawHeaders = request.rawHeaders
      request.resume()
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify(responsePayload))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    try {
      const address = server.address()
      if (!address || typeof address === "string") {
        throw new Error("Expected a local HTTP address")
      }
      state.copilotApiUrl = `http://127.0.0.1:${address.port}`
      globalThis.fetch = originalFetch
      await createMessages(createPayload(), "context-management-2025-06-27", {
        requestId: "request-1",
      })

      const headerNames = rawHeaders.filter((_, index) => index % 2 === 0)
      for (const headerName of [
        "anthropic-version",
        "anthropic-beta",
        "User-Agent",
        "Content-Type",
        "Authorization",
        "X-Request-Id",
        "X-GitHub-Api-Version",
        "OpenAI-Intent",
        "X-Interaction-Type",
        "VScode-SessionId",
        "VScode-MachineId",
        "Editor-Device-Id",
        "Editor-Plugin-Version",
        "Editor-Version",
      ]) {
        expect(headerNames).toContain(headerName)
      }
      expect(rawHeaders[rawHeaders.indexOf("Authorization") + 1]).toBe(
        "Bearer test-github-token",
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test.each([
    { version: undefined, expectedVersion: "2023-06-01" },
    {
      version: "client-selected-version",
      expectedVersion: "client-selected-version",
    },
  ])(
    "uses anthropic-version %j with the captured header casing",
    async ({ version, expectedVersion }) => {
      const payload = createPayload()
      const result = await createMessages(
        payload,
        "interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,advanced-tool-use-2025-11-20,unknown-beta",
        {
          anthropicVersionHeader: version,
          requestId: "original-request-id",
          sessionId: "interaction-1",
          compactType: COMPACT_REQUEST,
        },
      )

      expect(result).toEqual(responsePayload)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("https://api.individual.githubcopilot.com/v1/messages")
      expect(init?.method).toBe("POST")
      expect(init?.body).toBe(JSON.stringify(payload))
      expect(getRequestHeaders()).toEqual({
        "anthropic-version": expectedVersion,
        "anthropic-beta":
          "interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,advanced-tool-use-2025-11-20",
        "User-Agent":
          "vscode_claude_code/2.1.304 (external, sdk-ts, agent-sdk/0.3.304)",
        "Content-Type": "application/json",
        Authorization: "Bearer test-github-token",
        "X-Request-Id": getRequestHeaders()["X-Request-Id"],
        "X-GitHub-Api-Version": "2026-08-01",
        "OpenAI-Intent": "messages-proxy",
        "X-Interaction-Type": "messages-proxy",
        "VScode-SessionId": "vscode-session-1",
        "VScode-MachineId": "machine-1",
        "Editor-Device-Id": "device-1",
        "Editor-Plugin-Version": "copilot-chat/1.144.0",
        "Editor-Version": "vscode/1.144.0",
      })
      expect(getRequestHeaders()["X-Request-Id"]).not.toBe(
        "original-request-id",
      )
    },
  )

  test("supports JSON metadata and generates a fresh request ID for every request", async () => {
    const payload = createPayload({
      metadata: {
        user_id: JSON.stringify({
          device_id: "device-1",
          session_id: "session-1",
        }),
      },
    })
    await createMessages(payload, undefined, {
      requestId: "original-request-id",
    })
    await createMessages(payload, undefined, {
      requestId: "original-request-id",
    })

    expect(getRequestHeaders()["X-Request-Id"]).not.toBe(
      getRequestHeaders(1)["X-Request-Id"],
    )
    expect(getRequestHeaders()["anthropic-beta"]).toBeUndefined()
  })

  test("requires a Copilot token before proxy requests", async () => {
    state.copilotToken = undefined
    const error = await getRejectedError(
      createMessages(createPayload(), undefined, { requestId: "request-1" }),
    )

    expect(error.message).toBe("Copilot token not found")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("uses the Messages proxy identity for claude-opus-4.8", async () => {
    await createMessages(
      createPayload({ model: "claude-opus-4.8" }),
      undefined,
      {
        requestId: "request-1",
      },
    )

    expect(getRequestHeaders().Authorization).toBe("Bearer test-github-token")
    expect(getRequestHeaders()["OpenAI-Intent"]).toBe("messages-proxy")
    expect(getRequestHeaders()["copilot-integration-id"]).toBeUndefined()
  })

  test("rejects proxy requests without a GitHub token before contacting upstream", async () => {
    state.githubToken = undefined
    const error = await getRejectedError(
      createMessages(createPayload(), undefined, { requestId: "request-1" }),
    )
    expect(error.message).toBe("GitHub token not found")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("preserves the configured enterprise host and omits unavailable device metadata", async () => {
    process.env.COPILOT_API_ENTERPRISE_URL = "https://example.test/"
    state.vsCodeSessionId = undefined
    state.macMachineId = undefined
    await createMessages(createPayload(), undefined, { requestId: "request-1" })

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://copilot-api.example.test/v1/messages",
    )
    expect(getRequestHeaders().host).toBeUndefined()
    expect(getRequestHeaders().connection).toBeUndefined()
    expect(getRequestHeaders()["VScode-SessionId"]).toBeUndefined()
    expect(getRequestHeaders()["VScode-MachineId"]).toBeUndefined()
  })
})

describe("Standard Copilot Messages request compatibility", () => {
  test.each([
    { metadata: undefined },
    { metadata: { user_id: "user_device-1_account_account-1" } },
  ])("keeps Copilot authentication for %j", async (overrides) => {
    state.githubToken = undefined
    await createMessages(createPayload(overrides), undefined, {
      anthropicVersionHeader: "client-selected-version",
      requestId: "request-1",
    })

    expect(getRequestHeaders().Authorization).toBe("Bearer test-copilot-token")
    expect(getRequestHeaders()["user-agent"]).toBe("GitHubCopilotChat/0.72.0")
    expect(new Headers(getRequestHeaders()).has("anthropic-version")).toBe(
      false,
    )
    expect(getRequestHeaders()["x-initiator"]).toBe("user")
    expect(getRequestHeaders()["x-request-id"]).toBe("request-1")
    expect(getRequestHeaders()["copilot-integration-id"]).toBe("vscode-chat")
  })

  test("keeps OpenCode OAuth identity and Copilot authentication for Claude metadata", async () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"
    state.githubToken = undefined
    await createMessages(createPayload(), undefined, {
      anthropicVersionHeader: "client-selected-version",
      requestId: "request-1",
    })

    expect(getRequestHeaders().Authorization).toBe("Bearer test-copilot-token")
    expect(getRequestHeaders()["User-Agent"]).toStartWith("opencode/")
    expect(getRequestHeaders()["Openai-Intent"]).toBe("conversation-edits")
    expect(new Headers(getRequestHeaders()).has("anthropic-version")).toBe(
      false,
    )
    expect(getRequestHeaders()["X-Request-Id"]).toBeUndefined()
  })

  test("requires a Copilot token for standard requests", async () => {
    state.copilotToken = undefined
    const error = await getRejectedError(
      createMessages(createPayload({ metadata: undefined }), undefined, {
        requestId: "request-1",
      }),
    )
    expect(error.message).toBe("Copilot token not found")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("preserves vision detection and agent initiation for image tool results", async () => {
    await createMessages(
      createPayload({
        metadata: undefined,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "test-image",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      undefined,
      { requestId: "request-1" },
    )

    expect(getRequestHeaders()["copilot-vision-request"]).toBe("true")
    expect(getRequestHeaders()["x-initiator"]).toBe("agent")
    expect(new Headers(getRequestHeaders()).has("anthropic-version")).toBe(
      false,
    )
  })

  test("returns upstream streaming events with the proxy identity", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    )
    const result = await createMessages(
      createPayload({ stream: true }),
      undefined,
      {
        requestId: "request-1",
      },
    )
    expect(isAsyncIterable(result)).toBe(true)
    if (!isAsyncIterable(result)) throw new Error("Expected a Messages stream")
    const events = []
    for await (const event of result) events.push(event)

    expect(events).toMatchObject([
      { event: "message_stop", data: '{"type":"message_stop"}' },
    ])
    expect(getRequestHeaders().Authorization).toBe("Bearer test-github-token")
  })

  test("preserves upstream HTTP errors", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    )
    const error = await getRejectedError(
      createMessages(createPayload(), undefined, { requestId: "request-1" }),
    )
    expect(error).toBeInstanceOf(HTTPError)
  })
})
