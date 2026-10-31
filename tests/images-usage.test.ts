import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import consola from "consola"

import type { ResolvedProviderConfig } from "~/lib/config"
import { ImageJsonMetadataReader } from "~/lib/image-json-metadata"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import {
  closeUsageStore,
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSessionsPage,
  getTokenUsageSummary,
  recordTokenUsageEvent,
} from "~/lib/token-usage"
import {
  normalizeImagesUsage,
  observeImagesResponse,
} from "~/lib/token-usage/images"
import { resolveTokenUsageCost } from "~/lib/token-usage/pricing"
import { logImageEditRequest } from "~/routes/images/request-logging"

const codex: ResolvedProviderConfig = {
  name: "codex",
  type: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  apiKey: "unused",
  authType: "oauth2",
}
const sampleUsage = {
  input_tokens: 14,
  input_tokens_details: { image_tokens: 0, text_tokens: 14 },
  output_tokens: 1372,
  output_tokens_details: { image_tokens: 1372, text_tokens: 0 },
  total_tokens: 1386,
}
const copilotImageUsage = {
  token_details: [
    {
      batch_size: 1_000_000,
      cost_per_batch: 500_000_000_000,
      model: "gpt-image-2.5-flare",
      token_count: 73,
      token_type: "input",
    },
    {
      batch_size: 1_000_000,
      cost_per_batch: 0,
      model: "gpt-image-2.5-flare",
      token_count: 0,
      token_type: "cache_read",
    },
    {
      batch_size: 1_000_000,
      cost_per_batch: 0,
      model: "gpt-image-2.5-flare",
      token_count: 0,
      token_type: "cache_write",
    },
    {
      batch_size: 1_000_000,
      cost_per_batch: 0,
      model: "gpt-image-2.5-flare",
      token_count: 0,
      token_type: "output",
    },
    {
      batch_size: 1_000_000,
      cost_per_batch: 3_000_000_000_000,
      model: "gpt-image-2.5-flare",
      token_count: 158,
      token_type: "image_output",
    },
  ],
  total_nano_aiu: 510_500_000,
}
const originalDbPath = process.env.COPILOT_API_SQLITE_DB_PATH

beforeEach(async () => {
  process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
  await closeUsageStore()
})
afterEach(async () => {
  await closeUsageStore()
  state.verbose = false
  if (originalDbPath === undefined)
    Reflect.deleteProperty(process.env, "COPILOT_API_SQLITE_DB_PATH")
  else process.env.COPILOT_API_SQLITE_DB_PATH = originalDbPath
})

const events = () =>
  getTokenUsageEventsPage({ period: "today", page: 1, pageSize: 20 })

describe("Copilot image usage", () => {
  test.each(["json", "sse"])(
    "reads standard usage and Copilot image charges from %s responses",
    async (format) => {
      const payload = {
        data: [{ b64_json: "image" }],
        usage: sampleUsage,
        copilot_usage: copilotImageUsage,
      }
      const text =
        format === "json" ?
          JSON.stringify(payload)
        : `event: image_generation.completed\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
      const response = observeImagesResponse(
        new Response(text, {
          headers: {
            "content-type":
              format === "json" ? "application/json" : "text/event-stream",
          },
        }),
        {
          providerConfig: { ...codex, name: "github-copilot" },
          model: "gpt-image-2.5-flare",
          operation: "generations",
          onMetadata: () => {},
        },
      )
      expect(await response.text()).toBe(text)
      const page = await events()
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        source: "copilot",
        provider_name: "github-copilot",
        input_tokens: sampleUsage.input_tokens,
        output_tokens: sampleUsage.output_tokens,
        total_tokens: sampleUsage.total_tokens,
        total_nano_aiu: 510_500_000,
        cost: { amount: 0.005105, currency: "USD", source: "copilot_aiu" },
      })
    },
  )

  test.each(["usage-first", "cost-first"])(
    "keeps usage and Copilot charges from separate SSE events (%s)",
    async (order) => {
      const chunks = [
        `data: ${JSON.stringify({ usage: sampleUsage })}\n\n`,
        `data: ${JSON.stringify({ copilot_usage: copilotImageUsage })}\n\n`,
      ]
      if (order === "cost-first") chunks.reverse()
      const text = `${chunks.join("")}data: [DONE]\n\n`
      const response = observe(new Response(text), {
        ...codex,
        name: "github-copilot",
      })
      await response.text()
      expect((await events()).items[0]).toMatchObject({
        input_tokens: 14,
        output_tokens: 1372,
        total_tokens: 1386,
        total_nano_aiu: 510_500_000,
        cost: { amount: 0.005105, source: "copilot_aiu" },
      })
    },
  )

  test("does not infer token usage from Copilot billing details", async () => {
    const response = observe(
      Response.json({ copilot_usage: copilotImageUsage }),
      {
        ...codex,
        name: "github-copilot",
      },
    )
    await response.text()
    expect((await events()).items[0]).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_nano_aiu: 510_500_000,
      cost: { amount: 0.005105, source: "copilot_aiu" },
    })
  })

  test.each([undefined, null, -1, "510500000"])(
    "retains standard usage when the reported Copilot charge is invalid (%s)",
    async (charge) => {
      const response = observe(
        Response.json({
          usage: sampleUsage,
          copilot_usage: { ...copilotImageUsage, total_nano_aiu: charge },
        }),
        { ...codex, name: "github-copilot" },
      )
      await response.text()
      expect((await events()).items[0]).toMatchObject({
        input_tokens: sampleUsage.input_tokens,
        output_tokens: sampleUsage.output_tokens,
        total_tokens: sampleUsage.total_tokens,
        total_nano_aiu: null,
        cost: null,
      })
    },
  )

  test("does not apply Copilot charges to other providers or failed responses", async () => {
    const payload = { data: [], copilot_usage: copilotImageUsage }
    for (const [provider, status] of [
      ["codex", 200],
      ["github-copilot", 429],
    ] as const) {
      const response = observe(Response.json(payload, { status }), {
        ...codex,
        name: provider,
      })
      await response.text()
    }
    expect((await events()).items).toHaveLength(0)
  })
})

function observe(
  response: Response,
  providerConfig = codex,
  onMetadata = (_metadata: Record<string, unknown>) => {},
) {
  return observeImagesResponse(response, {
    model: "gpt-image-2",
    operation: "generations",
    providerConfig,
    onMetadata,
  })
}

describe("image response metadata", () => {
  test("extracts every non-image field across arbitrary chunk boundaries", () => {
    const metadata: Array<Record<string, unknown>> = []
    const reader = new ImageJsonMetadataReader((value) => metadata.push(value))
    const text = JSON.stringify({
      created: 123,
      data: [
        {
          b64_json: "x".repeat(2_000_000),
          revised_prompt: 'a \\"quoted\\" {cat}',
        },
      ],
      size: "1024x1024",
      quality: "low",
      background: "opaque",
      output_format: "png",
      usage: sampleUsage,
      extra: [true, null, { text: 'a "brace}" caf\u00e9' }],
    })
    for (let offset = 0; offset < text.length; offset += 173)
      reader.write(text.slice(offset, offset + 173))
    expect(metadata).toEqual([
      {
        created: 123,
        size: "1024x1024",
        quality: "low",
        background: "opaque",
        output_format: "png",
        usage: sampleUsage,
        extra: [true, null, { text: 'a "brace}" caf\u00e9' }],
      },
    ])
  })

  test("handles SSE, escaped keys, empty objects, and oversized metadata", () => {
    const values: Array<Record<string, unknown>> = []
    const reader = new ImageJsonMetadataReader((value) => values.push(value))
    reader.write(
      'event: image_generation.partial_image\r\ndata: {"type":"image_generation.partial_image","partial_image_b64":"ignore"}\r\n\r\n',
    )
    reader.write(
      `data: {"data":[],"oversized":"${"a".repeat(70_000)}","us\\u0061ge":${JSON.stringify(sampleUsage)}}\n\ndata: {}\n\ndata: [DONE]`,
    )
    expect(values).toEqual([
      { type: "image_generation.partial_image" },
      { usage: sampleUsage },
      {},
    ])
  })

  test("skips malformed and unfinished fields", () => {
    const values: Array<Record<string, unknown>> = []
    const reader = new ImageJsonMetadataReader((value) => values.push(value))
    reader.write('{"invalid":undefined,"ok":true}\n{"unfinished":"')
    expect(values).toEqual([{ ok: true }])
  })
})

describe("image usage and pricing", () => {
  test("prices the Codex example with standard image and text rates", () => {
    expect(
      resolveTokenUsageCost({
        ...normalizeImagesUsage(sampleUsage, "codex"),
        source: "provider",
        providerName: "codex",
        endpoint: "images_generations",
        model: "gpt-image-2",
      }),
    ).toEqual({
      currency: "USD",
      source: "builtin",
      total_cost_nanos: 41_230_000,
    })
  })

  test.each([
    "gpt-image-2-2026-04-21",
    "gpt-image-2.5",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst-2026-09-08",
    "gpt-image-2.5-flare",
  ])("prices %s by modality", (model) => {
    expect(
      resolveTokenUsageCost({
        source: "provider",
        providerName: "codex",
        endpoint: "images_edits",
        model,
        input_tokens: 100,
        input_tokens_details: { image_tokens: 80, text_tokens: 20 },
        output_tokens: 200,
      })?.total_cost_nanos,
    ).toBe(6_740_000)
  })

  test("uses text details, clamps inconsistent totals, and does not bill text output", () => {
    expect(
      resolveTokenUsageCost({
        source: "provider",
        providerName: "codex",
        endpoint: "images_edits",
        model: "gpt-image-2.5",
        input_tokens: 100,
        input_tokens_details: { text_tokens: 20 },
        output_tokens: 200,
        output_tokens_details: { text_tokens: 50 },
      })?.total_cost_nanos,
    ).toBe(5_240_000)
    expect(
      resolveTokenUsageCost({
        source: "provider",
        providerName: "codex",
        endpoint: "images_edits",
        model: "gpt-image-2",
        input_tokens: 10,
        input_tokens_details: { image_tokens: 100 },
        output_tokens: 0,
      })?.total_cost_nanos,
    ).toBe(80_000)
  })

  test("does not guess unknown model prices or fabricate a cost for empty usage", () => {
    for (const model of [
      "gpt-image-1",
      "gpt-image-1-mini",
      "gpt-image-1.5",
      "chatgpt-image-latest",
      "gpt-image-3",
      "unknown",
      "constructor",
    ]) {
      expect(
        resolveTokenUsageCost({
          source: "provider",
          providerName: "codex",
          endpoint: "images_generations",
          model,
          input_tokens: 14,
          output_tokens: 1372,
        }),
      ).toBeNull()
    }
    expect(
      resolveTokenUsageCost({
        source: "provider",
        providerName: "codex",
        endpoint: "images_generations",
        model: "gpt-image-2",
      }),
    ).toBeNull()
  })

  test("derives totals from details and rejects invalid token/cost fields", () => {
    const normalized = normalizeImagesUsage(
      {
        input_tokens: -1,
        input_tokens_details: { image_tokens: 12.8, text_tokens: 3 },
        output_tokens: "100",
        output_tokens_details: { image_tokens: 40, text_tokens: Infinity },
        total_tokens: NaN,
        cost_in_usd_ticks: -1,
      },
      "xai",
    )
    expect(normalized.input_tokens).toBe(15)
    expect(normalized.output_tokens).toBe(40)
    expect(normalized.total_tokens).toBeUndefined()
    expect(normalized.cost).toBeUndefined()
    for (const invalid of [undefined, null, [], "text"])
      expect(normalizeImagesUsage(invalid, "codex")).toEqual({})
    expect(
      normalizeImagesUsage({ cost_in_usd_ticks: 100 }, "codex").cost,
    ).toBeUndefined()
  })

  test("persists xAI cost-only usage in event, model, daily, and session totals", async () => {
    const response = requestContext.run(
      {
        traceId: "image-trace",
        startTime: Date.now(),
        userAgent: "image-client",
        sessionAffinity: "image-session",
        parentSessionId: undefined,
      },
      () =>
        observe(
          Response.json({
            data: [{ url: "https://imgen.x.ai/image.png" }],
            usage: { cost_in_usd_ticks: 400_000_000 },
          }),
          { ...codex, name: "xai" },
        ),
    )
    await response.text()
    const page = await events()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      source: "provider",
      provider_name: "xai",
      trace_id: "image-trace",
      user_agent: "image-client",
      session_id: "image-session",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost: {
        amount: 0.04,
        currency: "USD",
        source: "upstream",
        total_cost_nanos: 40_000_000,
      },
    })
    const summary = await getTokenUsageSummary("today")
    expect(summary.totals.request_count).toBe(1)
    expect(summary.totals.costs[0]?.amount).toBe(0.04)
    expect(summary.byModel[0]?.costs[0]?.amount).toBe(0.04)
    expect(
      (await getTokenUsageDailySummary("today")).days[0]?.totals.costs[0]
        ?.amount,
    ).toBe(0.04)
    expect(
      (
        await getTokenUsageSessionsPage({
          period: "today",
          page: 1,
          pageSize: 20,
        })
      ).items[0]?.costs[0]?.amount,
    ).toBe(0.04)
  })

  test("keeps valid zero-dollar upstream requests and ignores missing/invalid usage", async () => {
    for (const usage of [
      { cost_in_usd_ticks: 0 },
      {},
      { cost_in_usd_ticks: "400000000" },
      { cost_in_usd_ticks: -1 },
    ]) {
      await observe(Response.json({ data: [], usage }), {
        ...codex,
        name: "xai",
      }).text()
    }
    const page = await events()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.cost?.amount).toBe(0)
  })

  test("records SSE once, preserves bytes, and retains complete usage on cancellation", async () => {
    const text = `event: image_generation.partial_image\r\ndata: {"b64_json":"ignore","type":"image_generation.partial_image"}\r\n\r\nevent: image_generation.completed\r\ndata: {"b64_json":"final","usage":${JSON.stringify(sampleUsage)}}\r\n\r\ndata: [DONE]\r\n\r\n`
    const metadata: Array<Record<string, unknown>> = []
    const chunks = [...new TextEncoder().encode(text)]
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const byte = chunks.shift()
        if (byte === undefined) controller.close()
        else controller.enqueue(Uint8Array.of(byte))
      },
    })
    expect(
      await observe(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
        codex,
        (value) => metadata.push(value),
      ).text(),
    ).toBe(text)
    expect((await events()).items).toHaveLength(1)
    expect(metadata[1]).toEqual({ usage: sampleUsage })

    const cancel = mock(() => {})
    const response = observe(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ usage: sampleUsage })),
            )
          },
          cancel,
        }),
      ),
    )
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel("client disconnected")
    expect(cancel).toHaveBeenCalledWith("client disconnected")
    expect((await events()).items).toHaveLength(2)
  })

  test("propagates stream errors and skips failed or bodyless responses", async () => {
    const failure = new Error("image stream failed")
    const response = observe(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(failure)
          },
        }),
      ),
    )
    expect(await response.text().catch((error: unknown) => error)).toBe(failure)
    const failed = observe(
      Response.json(
        { usage: sampleUsage, error: { message: "no image" } },
        { status: 400 },
      ),
    )
    expect(failed.status).toBe(400)
    await failed.text()
    expect(observe(new Response(null, { status: 204 })).status).toBe(204)
    await observe(new Response("not JSON")).text()
    expect((await events()).items).toHaveLength(0)
  })

  test("does not admit unsupported provider costs or empty events", async () => {
    recordTokenUsageEvent({
      endpoint: "images_generations",
      model: "unknown",
      providerName: "custom",
      source: "provider",
      cost: 2,
    })
    expect((await events()).items).toHaveLength(0)
  })
})

describe("image request metadata and logs", () => {
  test("logs edit fields with nested image and mask base64 removed", async () => {
    state.verbose = true
    const logger = consola.create({ reporters: [] })
    const debug = Object.assign(
      mock((_label: string, _value: string) => {}),
      { raw: logger.debug.raw },
    )
    logger.debug = debug
    const payload = {
      model: "gpt-image-2",
      prompt: "make it green",
      n: 1,
      quality: "high",
      background: null,
      images: [
        { image_url: "data:image/png;base64,secret-image" },
        { image_url: "https://example.com/image.png" },
      ],
      mask: { b64_json: "secret-mask", mime_type: "image/png" },
    }
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const forwarded = await logImageEditRequest(
      logger,
      "images.edits.codex.request",
      request,
    )
    expect(await forwarded.json()).toEqual(payload)
    expect(debug).toHaveBeenCalledTimes(1)
    const logged: unknown = JSON.parse(debug.mock.calls[0][1])
    expect(logged).toMatchObject({
      body: {
        model: payload.model,
        prompt: payload.prompt,
        n: 1,
        quality: "high",
        background: null,
        images: [
          { image_url: "[image base64 omitted]" },
          { image_url: "https://example.com/image.png" },
        ],
        mask: { b64_json: "[image base64 omitted]", mime_type: "image/png" },
      },
    })
    expect(JSON.stringify(logged)).not.toContain("secret-")
  })

  test("logs selected staged fields without consuming the multipart body", async () => {
    const logger = consola.create({ reporters: [] })
    const debug = Object.assign(
      mock((_label: string, _value: string) => {}),
      { raw: logger.debug.raw },
    )
    logger.debug = debug
    const request = new Request("http://localhost", {
      method: "POST",
      body: "invalid",
    })
    await logImageEditRequest(logger, "edit", request)
    expect(debug).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
    state.verbose = true
    await (await logImageEditRequest(logger, "edit", request)).text()
    expect(debug.mock.calls[0]?.[1]).toContain("[unavailable JSON body]")
    const form = new FormData()
    form.append("model", "image-model")
    form.append("prompt", "a cat")
    form.append("size", "1024x1024")
    form.append("private_option", "do-not-log")
    form.append(
      "image",
      new File(["secret-image"], "cat.png", { type: "image/png" }),
    )
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++
          throw new Error("multipart body must not be read for logging")
        },
      },
      { highWaterMark: 0 },
    )
    const multipart = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=example" },
      body,
      duplex: "half",
    } as RequestInit)
    const forwarded = await logImageEditRequest(
      logger,
      "edit",
      multipart,
      { provider: "custom" },
      undefined,
      form,
    )
    const logged = debug.mock.calls[1]?.[1] ?? ""
    expect(JSON.parse(logged)).toMatchObject({
      provider: "custom",
      body: [
        { name: "model", value: "image-model" },
        { name: "prompt", value: "a cat" },
        { name: "size", value: "1024x1024" },
      ],
    })
    expect(logged).not.toContain("secret-image")
    expect(logged).not.toContain("do-not-log")
    expect(logged).not.toContain("cat.png")
    expect(forwarded.bodyUsed).toBe(false)
    expect(pulls).toBe(0)
    await forwarded.body?.cancel()
  })

  test("bounds long multipart log fields without changing the form", async () => {
    state.verbose = true
    const logger = consola.create({ reporters: [] })
    const debug = Object.assign(
      mock((_label: string, _value: string) => {}),
      { raw: logger.debug.raw },
    )
    logger.debug = debug
    const form = new FormData()
    const prompt = "x".repeat(10_000)
    form.set("prompt", prompt)
    const request = new Request("http://localhost", {
      method: "POST",
      body: form,
    })
    await logImageEditRequest(logger, "edit", request, {}, undefined, form)
    const logged = debug.mock.calls[0]?.[1] ?? ""
    expect(logged).toContain("[truncated]")
    expect(logged.length).toBeLessThan(9_000)
    expect(form.get("prompt")).toBe(prompt)
    expect(request.bodyUsed).toBe(false)
  })
})
