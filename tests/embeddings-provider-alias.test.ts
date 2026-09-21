import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import {
  embeddingRouteDependencies,
  embeddingRoutes,
  PROVIDER_EMBEDDINGS_RESPONSE_BYTE_LIMIT,
} from "~/routes/embeddings/route"

const providerConfig: ResolvedProviderConfig = {
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://azure-openai.example/openai",
  name: "azure-openai",
  type: "openai-compatible",
}

const originalDependencies = { ...embeddingRouteDependencies }
const forwardProviderEmbeddings = mock(
  (
    ..._args: Parameters<
      typeof embeddingRouteDependencies.forwardProviderEmbeddings
    >
  ) =>
    Promise.resolve(
      Response.json({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1], index: 0 }],
        model: "text-embedding-3-large",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      }),
    ),
)

beforeEach(() => {
  forwardProviderEmbeddings.mockClear()
  embeddingRouteDependencies.resolveMappedModel = (model) =>
    model === "embedding" ? "azure-openai/text-embedding-3-large" : model
  embeddingRouteDependencies.resolveProviderConfig = (provider) =>
    Promise.resolve(provider === "azure-openai" ? providerConfig : null)
  embeddingRouteDependencies.forwardProviderEmbeddings =
    forwardProviderEmbeddings
})

afterEach(() => {
  Object.assign(embeddingRouteDependencies, originalDependencies)
})

describe("provider/model aliases on embeddings route", () => {
  test("proxies the original provider embeddings body without cloning", async () => {
    const upstreamBody = {
      object: "list",
      data: [{ object: "embedding", embedding: [0.1], index: 0 }],
      model: "text-embedding-3-large",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }
    const upstreamText = `${JSON.stringify(upstreamBody, null, 2)}\n`
    const upstreamResponse = new Response(upstreamText, {
      headers: {
        "content-type": "application/json",
        "x-provider-response": "preserved",
      },
    })
    Object.defineProperty(upstreamResponse, "clone", {
      value: () => {
        throw new Error("The upstream response must only be consumed once")
      },
    })
    forwardProviderEmbeddings.mockImplementationOnce(() =>
      Promise.resolve(upstreamResponse),
    )

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)

    const response = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "embedding", input: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-provider-response")).toBe("preserved")
    expect(await response.text()).toBe(upstreamText)
  })

  test("cancels provider responses that exceed the byte limit", async () => {
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason
      },
    })
    forwardProviderEmbeddings.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(body, {
          status: 500,
          headers: {
            "content-length": String(
              PROVIDER_EMBEDDINGS_RESPONSE_BYTE_LIMIT + 1,
            ),
          },
        }),
      ),
    )

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)

    const response = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "embedding", input: "hello" }),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: `Upstream response exceeds the size limit of ${PROVIDER_EMBEDDINGS_RESPONSE_BYTE_LIMIT} bytes`,
        type: "upstream_error",
      },
    })
    await Promise.resolve()
    expect(cancelReason).toBeInstanceOf(Error)
  })

  test("routes a mapped embedding model to its configured provider", async () => {
    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)

    const response = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "embedding", input: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(forwardProviderEmbeddings).toHaveBeenCalledTimes(1)
    const [config, payload, headers, options] =
      forwardProviderEmbeddings.mock.calls[0]
    expect(config).toBe(providerConfig)
    expect(payload).toEqual({
      model: "text-embedding-3-large",
      input: "hello",
    })
    expect(headers.get("content-type")).toBe("application/json")
    expect(options?.clientSignal).toBeInstanceOf(AbortSignal)
  })
})
