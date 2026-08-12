import { afterEach, describe, expect, test } from "bun:test"

import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import { getModels } from "~/services/codex/get-models"
import {
  buildCodexResponsesWebSocketPayload,
  buildCodexResponsesWebSocketUrl,
  buildCodexResponsesHeaders,
  prepareCodexResponsesWebSocketRequest,
  resolveCodexResponsesUrl,
} from "~/services/codex/create-responses"

const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId

afterEach(() => {
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
})

describe("codex api helpers", () => {
  test("resolves the ChatGPT Codex responses path", () => {
    expect(resolveCodexResponsesUrl()).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    )
    expect(resolveCodexResponsesUrl("https://chatgpt.com/backend-api/")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    )
    expect(
      resolveCodexResponsesUrl("https://chatgpt.com/backend-api/codex"),
    ).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(
      resolveCodexResponsesUrl(
        "https://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBe("https://chatgpt.com/backend-api/codex/responses")
  })

  test("builds the ChatGPT Codex websocket responses path", () => {
    expect(buildCodexResponsesWebSocketUrl()).toBe(
      "wss://chatgpt.com/backend-api/codex/responses",
    )
    expect(
      buildCodexResponsesWebSocketUrl("https://chatgpt.com/backend-api/"),
    ).toBe("wss://chatgpt.com/backend-api/codex/responses")
  })

  test("builds the Codex websocket response.create payload", () => {
    const payload = buildCodexResponsesWebSocketPayload({
      input: "hello",
      model: "gpt-5.4",
      store: false,
      stream: true,
    })

    expect(payload).toEqual({
      input: "hello",
      model: "gpt-5.4",
      store: false,
      type: "response.create",
    })
    expect("stream" in payload).toBe(false)
  })

  test("moves system input messages into instructions when they are empty", () => {
    const payload = buildCodexResponsesWebSocketPayload({
      input: [
        { role: "system", content: "follow the repo style" },
        { role: "user", content: "hello" },
      ],
      instructions: "",
      model: "gpt-5.4",
      stream: true,
    })

    expect(payload).toEqual({
      input: [{ role: "user", content: "hello" }],
      instructions: "follow the repo style",
      model: "gpt-5.4",
      store: false,
      type: "response.create",
    })
  })

  test("keeps system messages after the first three messages in input", () => {
    const payload = buildCodexResponsesWebSocketPayload({
      input: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
        { role: "system", content: "late system prompt" },
      ],
      instructions: null,
      model: "gpt-5.4",
      stream: true,
    })

    expect(payload.instructions).toBeNull()
    expect(payload.input).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
      { role: "system", content: "late system prompt" },
    ])
  })

  test("overrides request account headers with loaded codex auth context", () => {
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const headers = buildCodexResponsesHeaders(
      new Headers({
        accept: "text/plain",
        authorization: "Bearer request-token",
        "chatgpt-account-id": "request-account",
        connection: "keep-alive",
        "content-type": "application/cloudevents+json",
        "openai-beta": "responses=stable",
        originator: "test-client",
        "user-agent": "test-agent",
        "x-trace-id": "trace-123",
      }),
    )

    expect(headers.get("authorization")).toBe("Bearer codex-token")
    expect(headers.get("chatgpt-account-id")).toBe("codex-account")
    expect(headers.get("connection")).toBeNull()
    expect(headers.get("content-type")).toBe("application/cloudevents+json")
    expect(headers.get("openai-beta")).toBe("responses=stable")
    expect(headers.get("originator")).toBe("test-client")
    expect(headers.get("user-agent")).toBe("test-agent")
  })

  test("fills missing codex headers when the request omits them", () => {
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const headers = buildCodexResponsesHeaders(new Headers())

    expect(headers.get("authorization")).toBe("Bearer codex-token")
    expect(headers.get("chatgpt-account-id")).toBe("codex-account")
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("originator")).toBe("copilot-api")
    expect(headers.get("user-agent")).toBe("copilot-api")
  })

  test("sets streaming and opencode-specific codex headers", () => {
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const headers = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "opencode",
      },
      () =>
        buildCodexResponsesHeaders(
          new Headers({
            "cf-ray": "cloudflare-ray",
            "user-agent": "opencode/1.0",
          }),
          { stream: true },
        ),
    )

    expect(headers.get("accept")).toBe("text/event-stream")
    expect(headers.get("cf-ray")).toBeNull()
    expect(headers.get("openai-beta")).toBeNull()
    expect(headers.get("originator")).toBe("opencode")
    expect(headers.get("session-id")).toBe("opencode-session")
  })

  test("prepares websocket requests without HTTP-only headers", () => {
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const request = prepareCodexResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-5.4",
        stream: true,
      },
      new Headers({
        accept: "text/plain",
        "content-type": "application/json",
        "x-trace-id": "trace-123",
      }),
    )

    expect(request.url).toBe("wss://chatgpt.com/backend-api/codex/responses")
    expect(request.payload).toMatchObject({
      input: "hello",
      model: "gpt-5.4",
      type: "response.create",
    })
    expect(request.headers.accept).toBeUndefined()
    expect(request.headers["content-type"]).toBeUndefined()
    expect(request.headers.authorization).toBe("Bearer codex-token")
    expect(request.headers["openai-beta"]).toBe(
      "responses_websockets=2026-02-06",
    )
  })

  test("returns the static codex model catalog", () => {
    const models = getModels()

    expect(models.object).toBe("list")
    expect(models.data.map((model) => model.id)).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])
    expect(
      models.data.every(
        (model) => !model.supported_endpoints?.includes("/v1/embeddings"),
      ),
    ).toBe(true)

    const gpt56Models = models.data.filter((model) =>
      model.id.startsWith("gpt-5.6-"),
    )
    expect(gpt56Models).toHaveLength(3)
    for (const model of gpt56Models) {
      expect(model.capabilities.supports.reasoning_effort).toEqual([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ])
      expect(model.capabilities.supports.reasoning_effort).not.toContain(
        "ultra",
      )
      expect(model.capabilities.limits.max_context_window_tokens).toBe(
        1_050_000,
      )
      expect(model.capabilities.limits.max_output_tokens).toBe(128_000)
    }

    expect(
      models.data.find((model) => model.id === "gpt-5.5")?.capabilities.supports
        .reasoning_effort,
    ).not.toContain("max")
  })
})
