import { describe, expect, test } from "bun:test"

import {
  normalizeProviderBaseUrl,
  resolveProviderAuthType,
  type ResolvedProviderConfig,
} from "~/lib/config"

import {
  buildProviderUpstreamHeaders,
  resolveProviderEndpointUrl,
} from "~/services/providers/provider-proxy"

function createProviderConfig(
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  return {
    name: "custom",
    type: "anthropic",
    baseUrl: "https://example.com",
    apiKey: "provider-key",
    authType: "x-api-key",
    ...overrides,
  }
}

describe("buildProviderUpstreamHeaders", () => {
  test("uses x-api-key auth by default", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig(),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "provider-key",
      "anthropic-version": "2023-06-01",
    })
  })

  test("uses Authorization bearer auth when configured", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ authType: "authorization" }),
      new Headers({
        accept: "application/json",
        "user-agent": "test-client",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
      "user-agent": "test-client",
    })
  })

  test("does not forward Anthropic-only headers to OpenAI-compatible providers", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({
        authType: "authorization",
        type: "openai-compatible",
      }),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })
  })

  test("sets an Anthropic API version for a selected models.dev provider", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ modelsDevProviderId: "anthropic-provider" }),
      new Headers(),
    )
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["x-api-key"]).toBe("provider-key")
  })
})

describe("resolveProviderAuthType", () => {
  test("supports OAuth bearer auth for xAI", () => {
    expect(resolveProviderAuthType("xai", "oauth2", "openai-responses")).toBe(
      "oauth2",
    )
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({
        name: "xai",
        type: "openai-responses",
        authType: "oauth2",
        apiKey: "xai-access-token",
      }),
      new Headers({
        authorization: "Bearer client-token",
        "x-api-key": "client-key",
      }),
    )
    expect(headers.authorization).toBe("Bearer xai-access-token")
    expect(headers["x-api-key"]).toBeUndefined()
  })
  test("falls back to OpenAI-compatible default for invalid authType", () => {
    expect(
      resolveProviderAuthType("dash", "invalid-auth-type", "openai-compatible"),
    ).toBe("authorization")
  })

  test("falls back to Anthropic default for invalid authType", () => {
    expect(
      resolveProviderAuthType("custom", "invalid-auth-type", "anthropic"),
    ).toBe("x-api-key")
  })

  test("falls back for non-codex oauth2 providers", () => {
    expect(
      resolveProviderAuthType("custom", "oauth2", "openai-responses"),
    ).toBe("authorization")
  })
})

describe("provider endpoint URL", () => {
  test.each([
    ["https://opencode.ai/zen/go", "https://opencode.ai/inference/go"],
    [" https://opencode.ai/zen/go/v1/ ", "https://opencode.ai/inference/go/v1"],
    ["https://opencode.ai/zen", "https://opencode.ai/zen"],
    ["https://opencode.ai/zen/gopher", "https://opencode.ai/zen/gopher"],
    ["https://proxy.example/zen/go", "https://proxy.example/zen/go"],
  ])("normalizes the legacy Go base URL %s", (baseUrl, expected) => {
    expect(normalizeProviderBaseUrl(baseUrl)).toBe(expected)
  })

  test.each([
    { type: "anthropic", endpoint: "messages" },
    { type: "openai-compatible", endpoint: "chat/completions" },
    { type: "openai-responses", endpoint: "responses" },
    { type: "google", endpoint: "models/gemini-test:generateContent" },
    { type: "google", endpoint: "models/gemini-test:streamGenerateContent" },
  ] as const)(
    "migrates Go $type requests without duplicating v1",
    ({ type, endpoint }) => {
      for (const baseUrl of [
        "https://opencode.ai/zen/go",
        "https://opencode.ai/zen/go/v1/",
        "https://opencode.ai/inference/go",
        "https://opencode.ai/inference/go/v1",
      ]) {
        expect(
          resolveProviderEndpointUrl(
            createProviderConfig({ name: "opencode-go", type, baseUrl }),
            endpoint,
          ),
        ).toBe(`https://opencode.ai/inference/go/v1/${endpoint}`)
      }
    },
  )

  test("uses models.dev API paths directly for all three supported protocols", () => {
    const provider = createProviderConfig({
      baseUrl: "https://api.example.com/anthropic/v1",
      modelsDevProviderId: "example",
    })
    expect(resolveProviderEndpointUrl(provider, "messages")).toBe(
      "https://api.example.com/anthropic/v1/messages",
    )
    expect(resolveProviderEndpointUrl(provider, "chat/completions")).toBe(
      "https://api.example.com/anthropic/v1/chat/completions",
    )
    expect(resolveProviderEndpointUrl(provider, "responses")).toBe(
      "https://api.example.com/anthropic/v1/responses",
    )
  })

  test("does not duplicate a catalog URL's final chat endpoint", () => {
    expect(
      resolveProviderEndpointUrl(
        createProviderConfig({
          baseUrl: "https://api.example.com/v1/chat/completions",
          modelsDevProviderId: "example",
        }),
        "chat/completions",
      ),
    ).toBe("https://api.example.com/v1/chat/completions")
  })

  test.each([
    { type: "anthropic", endpoint: "messages" },
    { type: "openai-compatible", endpoint: "chat/completions" },
    { type: "openai-responses", endpoint: "responses" },
  ] as const)(
    "adds v1 once for manual $type requests",
    ({ type, endpoint }) => {
      for (const baseUrl of [
        "https://api.example.com/api",
        "https://api.example.com/api/v1",
        "https://api.example.com/api/v1/",
      ]) {
        expect(
          resolveProviderEndpointUrl(
            createProviderConfig({ type, baseUrl }),
            endpoint,
          ),
        ).toBe(`https://api.example.com/api/v1/${endpoint}`)
      }
    },
  )
})
