import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/lib/types/responses"

import { state } from "~/lib/state"
import {
  buildCodexResponsesHeaders,
  buildCodexResponsesWebSocketHeaders,
  prepareCodexResponsesWebSocketRequest,
} from "~/services/codex/create-responses"

const originalAccessToken = state.codexAccessToken
const originalAccountId = state.codexAccountId
const liteMetadataKey =
  "ws_request_header_x_openai_internal_codex_responses_lite"
const startMetadataKey = "x-codex-ws-stream-request-start-ms"

const preparePayloadForSend = (payload: ResponsesPayload, headers: Headers) => {
  const request = prepareCodexResponsesWebSocketRequest(payload, headers)
  if (!request.preparePayload) {
    throw new Error("Expected Codex to prepare metadata before sending")
  }
  return request.preparePayload(request.payload)
}

beforeEach(() => {
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
})

afterEach(() => {
  state.codexAccessToken = originalAccessToken
  state.codexAccountId = originalAccountId
})

describe("Codex WebSocket headers", () => {
  test.each([
    ["codex-tui/0.167.0", "thread-1", true],
    ["CoDeX Desktop/0.167.0", "thread-1", true],
    ["opencode/1.0", "thread-1", false],
    ["codex-tui/0.167.0", "", false],
  ])(
    "keeps request ID pool isolation for UA=%s, thread=%s unless it is a Codex thread",
    (userAgent, threadId, reuse) => {
      const headers = new Headers({
        "user-agent": userAgent,
        "thread-id": threadId,
        "x-client-request-id": "request-1",
      })
      const first = prepareCodexResponsesWebSocketRequest(
        { model: "gpt-5.4" },
        headers,
      )
      headers.set("x-client-request-id", "request-2")
      const second = prepareCodexResponsesWebSocketRequest(
        { model: "gpt-5.4" },
        headers,
      )

      expect(first.poolKey === second.poolKey).toBe(reuse)
      expect(first.headers["x-client-request-id"]).toBe("request-1")
      expect(second.headers["x-client-request-id"]).toBe("request-2")
      headers.set("thread-id", "thread-2")
      expect(
        prepareCodexResponsesWebSocketRequest({ model: "gpt-5.4" }, headers)
          .poolKey,
      ).not.toBe(second.poolKey)
    },
  )

  test.each([
    { model: "gpt-5.4", serviceTier: undefined, routingHint: "model=gpt-5.4" },
    {
      model: "gpt-5.3-codex",
      serviceTier: null,
      routingHint: "model=gpt-5.3-codex",
    },
    { model: "gpt-5.4", serviceTier: "", routingHint: "model=gpt-5.4" },
    {
      model: "gpt-5.3-codex",
      serviceTier: "priority",
      routingHint: "model=gpt-5.3-codex;tier=priority",
    },
  ])(
    "formats the routing hint from the request: %j",
    ({ model, serviceTier, routingHint }) => {
      const payload = { model, service_tier: serviceTier }
      const request = prepareCodexResponsesWebSocketRequest(
        payload,
        new Headers(),
      )

      expect(request.headers["x-codex-routing-hint"]).toBe(routingHint)
      expect(
        buildCodexResponsesHeaders(new Headers(), { payload }).get(
          "x-codex-routing-hint",
        ),
      ).toBe(routingHint)
    },
  )

  test("uses the requested model for routing and overrides an incoming hint", () => {
    const inbound = new Headers({
      "user-agent": "codex-tui/0.167.0",
      "thread-id": "thread-1",
      "x-codex-routing-hint": "model=stale-model",
    })
    const firstRequest = prepareCodexResponsesWebSocketRequest(
      { model: "gpt-5.4" },
      inbound,
    )
    const secondRequest = prepareCodexResponsesWebSocketRequest(
      { model: "gpt-5.3-codex" },
      inbound,
    )
    const priorityRequest = prepareCodexResponsesWebSocketRequest(
      { model: "gpt-5.4", service_tier: "priority" },
      inbound,
    )

    expect(firstRequest.headers["x-codex-routing-hint"]).toBe("model=gpt-5.4")
    expect(secondRequest.headers["x-codex-routing-hint"]).toBe(
      "model=gpt-5.3-codex",
    )
    expect(firstRequest.poolKey).not.toBe(secondRequest.poolKey)
    expect(firstRequest.poolKey).not.toBe(priorityRequest.poolKey)
    expect(inbound.get("x-codex-routing-hint")).toBe("model=stale-model")
  })

  test.each(["true", "false", ""])(
    "strips internal headers from the handshake when responses-lite is %s",
    (responsesLite) => {
      const inbound = new Headers({
        "X-OpenAI-Internal-Codex-Responses-Lite": responsesLite,
        "X-Codex-Turn-State": "turn-state-123",
      })
      const request = prepareCodexResponsesWebSocketRequest(
        { model: "gpt-5.4" },
        inbound,
      )

      expect(request.headers).not.toHaveProperty(
        "x-openai-internal-codex-responses-lite",
      )
      expect(request.headers).not.toHaveProperty("x-codex-turn-state")

      const httpHeaders = buildCodexResponsesHeaders(inbound)
      expect(httpHeaders.get("x-openai-internal-codex-responses-lite")).toBe(
        responsesLite,
      )
      expect(httpHeaders.get("x-codex-turn-state")).toBe("turn-state-123")
      expect(inbound.get("x-openai-internal-codex-responses-lite")).toBe(
        responsesLite,
      )
      expect(inbound.get("x-codex-turn-state")).toBe("turn-state-123")
    },
  )
})

describe("Codex version headers", () => {
  test.each([
    ["codex-tui/0.155.1 (Windows 11; x86_64)", "0.155.1"],
    ["codex_cli_rs/0.155.1 (Linux; x86_64)", "0.155.1"],
    ["codex_vscode/0.155.1 (Mac OS; arm64) vscode/1.110.0", "0.155.1"],
    ["codex-vscode/0.155.1 (Windows; x86_64)", "0.155.1"],
    ["Codex/26.914.555 (Mac OS; arm64) Electron/40.0.0", "26.914.555"],
    ["codex-desktop/0.155.1 (Mac OS; arm64)", "0.155.1"],
    ["Mozilla/5.0 codex_desktop/0.155.1", "0.155.1"],
    ["Codex Desktop/0.158.0", "0.158.0"],
    ["Codex Desktop/0.158.0-alpha.2", "0.158.0"],
    ["Codex Desktop/0.158.0-alpha.2+build.7 (Windows; x86_64)", "0.158.0"],
    ["Codex Desktop/0.158.0+build.7", "0.158.0"],
    ["codex-tui/0.155.1-alpha.2+build.7 (Linux)", "0.155.1"],
  ])("extracts %s for HTTP and WS", (userAgent, version) => {
    const inbound = new Headers({ "user-agent": userAgent })

    expect(buildCodexResponsesHeaders(inbound).get("version")).toBe(version)
    expect(buildCodexResponsesWebSocketHeaders(inbound).version).toBe(version)
    expect(inbound.has("version")).toBe(false)
  })

  test("prefers the incoming version over the UA version", () => {
    const inbound = new Headers({
      "user-agent": "Codex Desktop/0.158.0-alpha.2",
      Version: "custom-client-version",
    })

    expect(buildCodexResponsesHeaders(inbound).get("version")).toBe(
      "custom-client-version",
    )
    expect(buildCodexResponsesWebSocketHeaders(inbound).version).toBe(
      "custom-client-version",
    )
  })

  test.each([
    "opencode/1.155.1",
    "vscode/1.110.0 Electron/40.0.0",
    "notcodex/0.155.1",
    "codex-tui/dev",
    "codex-tui/0.155.1.2",
    "Codex Desktop/dev",
    "Codex Desktop/0.158.0.2",
    "",
  ])("omits version for unsupported UA %s", (userAgent) => {
    const inbound = new Headers({ "user-agent": userAgent })

    expect(buildCodexResponsesHeaders(inbound).has("version")).toBe(false)
    expect(buildCodexResponsesWebSocketHeaders(inbound).version).toBeUndefined()
  })

  test("omits version when both version and UA are absent", () => {
    expect(buildCodexResponsesHeaders(new Headers()).has("version")).toBe(false)
  })
})

describe("Codex responses lite metadata", () => {
  test.each(["true", "false", "custom-value"])(
    "copies the incoming header value %s without changing metadata",
    (value) => {
      const clientMetadata = { existing: "preserved", [liteMetadataKey]: "old" }
      const payload = preparePayloadForSend(
        { model: "gpt-5.4", client_metadata: clientMetadata },
        new Headers({ "X-OpenAI-Internal-Codex-Responses-Lite": value }),
      )

      expect(payload.client_metadata).toMatchObject({
        existing: "preserved",
        [liteMetadataKey]: value,
      })
      expect(clientMetadata[liteMetadataKey]).toBe("old")
    },
  )

  test("creates metadata when only the header is provided", () => {
    const payload = preparePayloadForSend(
      { model: "gpt-5.4", client_metadata: null },
      new Headers({ "x-openai-internal-codex-responses-lite": "true" }),
    )

    expect(payload.client_metadata).toMatchObject({
      [liteMetadataKey]: "true",
    })
  })

  test.each([
    new Headers(),
    new Headers({
      "x-openai-internal-codex-responses-lite": "",
    }),
  ])("omits lite metadata when the header has no value: %j", (headers) => {
    const clientMetadata = { existing: "preserved", [liteMetadataKey]: "old" }
    const payload = preparePayloadForSend(
      { model: "gpt-5.4", client_metadata: clientMetadata },
      headers,
    )

    expect(payload.client_metadata).toMatchObject({
      existing: "preserved",
    })
    expect(payload.client_metadata?.[liteMetadataKey]).toBeUndefined()
    expect(clientMetadata[liteMetadataKey]).toBe("old")
  })

  test("adds only the send timestamp when lite header and metadata are absent", () => {
    const payload = preparePayloadForSend({ model: "gpt-5.4" }, new Headers())
    expect(Object.keys(payload.client_metadata ?? {})).toEqual([
      startMetadataKey,
    ])
    expect(payload.client_metadata?.[startMetadataKey]).toMatch(/^\d+$/u)
  })
})
