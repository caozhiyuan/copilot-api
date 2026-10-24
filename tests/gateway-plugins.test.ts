import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Hono } from "hono"

import {
  GatewayPlugins,
  loadGatewayPlugins,
  type GatewayPluginEvents,
} from "~/lib/gateway-plugins"
import {
  requestEventsMiddleware,
  setPluginRequestModel,
} from "~/lib/request-events"
import { traceIdMiddleware } from "~/lib/trace"
import { createAuthMiddleware } from "~/lib/request-auth"
import { zstdDecompressionMiddleware } from "~/lib/zstd-request"
import {
  recordTokenUsageEvent,
  createTokenUsageRecorder,
  closeUsageStore,
  getTokenUsageEventsPage,
} from "~/lib/token-usage"

const runtimes: Array<GatewayPlugins> = []
const previousDb = process.env.COPILOT_API_SQLITE_DB_PATH
const previousMonitorDir = process.env.COPILOT_API_MONITOR_DIR

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((plugins) => plugins.close()))
  await closeUsageStore()
  if (previousDb === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
  else process.env.COPILOT_API_SQLITE_DB_PATH = previousDb
  if (previousMonitorDir === undefined)
    delete process.env.COPILOT_API_MONITOR_DIR
  else process.env.COPILOT_API_MONITOR_DIR = previousMonitorDir
})

function runtime() {
  const plugins = new GatewayPlugins(5000)
  runtimes.push(plugins)
  return plugins
}

async function appWithEvents(keys: Array<string> = []) {
  const plugins = runtime()
  const starts: Array<GatewayPluginEvents["request.start"]> = []
  const models: Array<GatewayPluginEvents["request.model"]> = []
  const chunks: Array<GatewayPluginEvents["request.first_chunk"]> = []
  const sessions: Array<GatewayPluginEvents["request.session"]> = []
  const ends: Array<GatewayPluginEvents["request.end"]> = []
  await plugins.register("collector", ({ on }) => {
    on("request.start", (event) => {
      starts.push(event)
    })
    on("request.model", (event) => {
      models.push(event)
    })
    on("request.session", (event) => {
      sessions.push(event)
    })
    on("request.first_chunk", (event) => {
      chunks.push(event)
    })
    on("request.end", (event) => {
      ends.push(event)
    })
  })
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(
    createAuthMiddleware({
      getApiKeys: () => keys,
      allowUnauthenticatedPaths: [],
    }),
  )
  app.use(requestEventsMiddleware(plugins, 5000))
  return { app, plugins, starts, models, sessions, chunks, ends }
}

const payload = JSON.stringify({ model: "original/model", input: "hello" })
const requestOptions = {
  method: "POST",
  body: payload,
  headers: {
    "content-type": "application/json",
    "user-agent": "plugin-test/1.0",
  },
}
const info = {
  id: "request-1",
  traceId: "trace-1",
  userAgent: "plugin-test/1.0",
  sessionId: null,
  path: "/v1/messages",
  port: 5000,
  startedAt: 123,
  model: null,
}

async function expectFailure(promise: Promise<unknown>, message: string) {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain(message)
}

describe("gateway plugin runtime", () => {
  test("preserves event order, snapshots and unsubscribe without awaiting plugin I/O", async () => {
    const plugins = runtime()
    let release = () => {}
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const values: Array<string | null> = []
    let off = () => {}
    await plugins.register("ordered", ({ on, version, server, log }) => {
      expect(version).toBe(1)
      expect(server).toEqual({ port: 5000, pid: process.pid })
      log("initialized")
      off = on("request.start", async (event) => {
        expect(Object.isFrozen(event)).toBe(true)
        await gate
        values.push(event.model)
      })
    })
    plugins.publish("request.start", info)
    plugins.publish("request.start", { ...info, model: "second" })
    expect(values).toEqual([])
    off()
    off()
    plugins.publish("request.start", { ...info, model: "ignored" })
    release()
    await plugins.flush()
    expect(values).toEqual([null, "second"])
    expect(plugins.enabled).toBe(false)
  })

  test("isolates failing hooks and removes subscriptions from failed setup", async () => {
    const plugins = runtime()
    await expectFailure(
      plugins.register("invalid", ({ on }) => {
        on("request.start", () => {
          throw new Error("must be unsubscribed")
        })
        throw new Error("setup failed")
      }),
      "setup failed",
    )
    expect(plugins.enabled).toBe(false)
    let seen = 0
    await plugins.register("throwing", ({ on }) => {
      on("request.start", () => {
        throw new Error("sync plugin failure")
      })
      on("request.start", () =>
        Promise.reject(new Error("async plugin failure")),
      )
    })
    await plugins.register("healthy", ({ on }) => {
      on("request.start", () => {
        seen++
      })
    })
    plugins.publish("request.start", info)
    await plugins.flush()
    expect(seen).toBe(1)
  })

  test("bounds a slow plugin queue and drains before cleanup exactly once", async () => {
    const plugins = runtime()
    let release = () => {}
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    let handled = 0
    let cleanups = 0
    await plugins.register("slow", ({ on }) => {
      on("request.start", async () => {
        await gate
        handled++
      })
      return () => {
        cleanups++
      }
    })
    for (let i = 0; i < 1100; i++) plugins.publish("request.start", info)
    const closed = plugins.close()
    expect(cleanups).toBe(0)
    release()
    await closed
    await plugins.close()
    expect(handled).toBe(1024)
    expect(cleanups).toBe(1)
    await expectFailure(
      plugins.register("late", () => {}),
      "closing",
    )
  })

  test("shutdown has a deadline and cleanup failures are isolated", async () => {
    const plugins = runtime()
    await plugins.register("bad-cleanup", () => () => {
      throw new Error("cleanup failed")
    })
    await plugins.register("hung", ({ on }) => {
      on("request.start", () => new Promise<void>(() => {}))
    })
    plugins.publish("request.start", info)
    await plugins.close(5)
    expect(plugins.enabled).toBe(false)
  })

  test("loads local modules relative to API home and skips failed modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-plugins-"))
    const output = join(dir, "events.json")
    writeFileSync(
      join(dir, "valid plugin.mjs"),
      `
      import { writeFileSync } from "node:fs";
      export default function setup({ on }) {
        on("request.start", event => writeFileSync(${JSON.stringify(output)}, JSON.stringify(event)));
      }
    `,
    )
    writeFileSync(join(dir, "invalid.mjs"), "export default {}")
    const plugins = await loadGatewayPlugins(
      JSON.stringify([
        "missing.mjs",
        "invalid.mjs",
        "valid plugin.mjs",
        "valid plugin.mjs",
      ]),
      { port: 5000, baseDir: dir },
    )
    expect(plugins).toBeDefined()
    runtimes.push(plugins!)
    plugins!.publish("request.start", info)
    await plugins!.flush()
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(info)
    expect(
      await loadGatewayPlugins(undefined, { port: 5000, baseDir: dir }),
    ).toBeUndefined()
    await expectFailure(
      loadGatewayPlugins("{}", { port: 5000, baseDir: dir }),
      "JSON array",
    )
    await expectFailure(
      loadGatewayPlugins('[""]', { port: 5000, baseDir: dir }),
      "JSON array",
    )
  })
})

describe("request event lifecycle", () => {
  test("reuses handler parsing, keeps metadata immutable and preserves response headers", async () => {
    const { app, plugins, starts, models, ends, chunks } = await appWithEvents()
    app.post("/v1/messages", async (c) => {
      const body = await c.req.json<{ model: string }>()
      setPluginRequestModel(body.model)
      setPluginRequestModel(body.model)
      body.model = "mapped/model"
      return c.json(body, 200, { "x-upstream": "preserved" })
    })
    const request = new Request("http://localhost/v1/messages", requestOptions)
    Object.defineProperty(request, "clone", {
      value: () => {
        throw new Error("request must not be cloned")
      },
    })
    const response = await app.request(request)
    expect(await response.json()).toEqual({
      model: "mapped/model",
      input: "hello",
    })
    expect(response.headers.get("x-upstream")).toBe("preserved")
    await plugins.flush()
    expect(starts).toHaveLength(1)
    expect(starts[0].model).toBeNull()
    expect(starts[0].userAgent).toBe("plugin-test/1.0")
    expect(starts[0].sessionId).toBeNull()
    expect(models.map((event) => event.model)).toEqual(["original/model"])
    expect(models[0].userAgent).toBe("plugin-test/1.0")
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({
      model: "original/model",
      userAgent: "plugin-test/1.0",
      port: 5000,
      status: 200,
      outcome: "completed",
      firstChunkMs: null,
      sessionId: null,
    })
    expect(chunks).toHaveLength(0)
  })

  test("starts before zstd upload and reports the model after existing decompression", async () => {
    const { app, plugins, starts, models, ends } = await appWithEvents()
    app.use("/v1/responses", zstdDecompressionMiddleware)
    app.post("/v1/responses", async (c) => {
      const body = await c.req.json<{ model: string }>()
      setPluginRequestModel(body.model)
      return c.json(body)
    })
    const compressed = Bun.zstdCompressSync(payload)
    let finishUpload = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(compressed.subarray(0, 4))
        finishUpload = () => {
          controller.enqueue(compressed.subarray(4))
          controller.close()
        }
      },
    })
    let started = () => {}
    const startedEvent = new Promise<void>((resolveStarted) => {
      started = resolveStarted
    })
    await plugins.register("start-observer", ({ on }) => {
      on("request.start", started)
    })
    const pending = app.request("/v1/responses", {
      method: "POST",
      body: stream,
      headers: { "content-encoding": "zstd" },
    })
    await startedEvent
    expect(models).toHaveLength(0)
    finishUpload()
    expect(await (await pending).json()).toMatchObject({
      model: "original/model",
    })
    await plugins.flush()
    expect(starts).toHaveLength(1)
    expect(models[0].model).toBe("original/model")
    expect(ends[0].port).toBe(5000)
    expect(starts[0].userAgent).toBe("")
    expect(models[0].userAgent).toBe("")
    expect(ends[0].userAgent).toBe("")
  })

  test("observes SSE completion and emits the first chunk only once", async () => {
    const { app, plugins, ends, chunks } = await appWithEvents()
    let release = () => {}
    app.post(
      "/v1/responses",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("event: ping\ndata: {}\n\n"),
              )
              release = () => {
                controller.enqueue(new TextEncoder().encode("data: done\n\n"))
                controller.close()
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const response = await app.request("/v1/responses", requestOptions)
    const reader = response.body!.getReader()
    await reader.read()
    await plugins.flush()
    expect(ends).toHaveLength(0)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].userAgent).toBe("plugin-test/1.0")
    release()
    while (!(await reader.read()).done) {
      /* drain */
    }
    await plugins.flush()
    expect(chunks).toHaveLength(1)
    expect(ends[0].firstChunkMs).not.toBeNull()
    expect(ends[0].durationMs).toBeGreaterThanOrEqual(ends[0].firstChunkMs!)
  })

  test("propagates cancellation and clears the request once", async () => {
    const { app, plugins, ends } = await appWithEvents()
    let cancelled = false
    app.post(
      "/v1/responses",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const response = await app.request("/v1/responses", requestOptions)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await plugins.flush()
    expect(cancelled).toBe(true)
    expect(ends).toHaveLength(1)
    expect(ends[0].outcome).toBe("cancelled")
  })

  test("preserves source errors and waits for live non-SSE bodies", async () => {
    const { app, plugins, ends, chunks } = await appWithEvents()
    let errorBody = () => {}
    app.post(
      "/alpha/search",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"))
              errorBody = () => controller.error(new Error("upstream failed"))
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    )
    const response = await app.request("/alpha/search", requestOptions)
    const reader = response.body!.getReader()
    await reader.read()
    await plugins.flush()
    expect(ends).toHaveLength(0)
    errorBody()
    await expectFailure(reader.read(), "upstream failed")
    await plugins.flush()
    expect(chunks).toHaveLength(0)
    expect(ends[0]).toMatchObject({ outcome: "error", firstChunkMs: null })
  })

  test("ignores rejected auth, non-generation routes and inactive plugins", async () => {
    const { app, plugins, starts } = await appWithEvents(["required-key"])
    app.post("/v1/messages", (c) => c.json({ ok: true }))
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      body: new ReadableStream<Uint8Array>(),
    })
    const response = await app.request(request)
    expect(response.status).toBe(401)
    await plugins.flush()
    expect(starts).toHaveLength(0)
    await app.request("/models", { headers: { "x-api-key": "required-key" } })
    await plugins.flush()
    expect(starts).toHaveLength(0)
    await plugins.close()
    expect(
      (
        await app.request("/v1/messages", {
          ...requestOptions,
          headers: { "x-api-key": "required-key" },
        })
      ).status,
    ).toBe(200)
  })

  test("finishes bodyless errors and aborts before response headers", async () => {
    const { app, plugins, ends } = await appWithEvents()
    app.post("/v1/messages", () => new Response(null, { status: 400 }))
    await app.request("/v1/messages", requestOptions)
    const controller = new AbortController()
    controller.abort()
    await app.request("/v1/messages", {
      ...requestOptions,
      signal: controller.signal,
    })
    await plugins.flush()
    expect(ends.map((e) => e.outcome)).toEqual(["error", "cancelled"])
    expect(ends[1].status).toBe(0)
  })

  test("observes existing usage without changing SQLite session accounting", async () => {
    process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
    await closeUsageStore()
    const { app, plugins, starts, ends, sessions } = await appWithEvents()
    const usages: Array<GatewayPluginEvents["usage.recorded"]> = []
    await plugins.register("usage", ({ on }) => {
      on("usage.recorded", (event) => {
        usages.push(event)
      })
    })
    app.post("/v1/messages", (c) => {
      recordTokenUsageEvent({
        source: "provider",
        providerName: "test",
        endpoint: "messages",
        model: "test-model",
        input_tokens: 2,
        output_tokens: 3,
        sessionId: "payload-session",
        fallbackSessionId: "fallback-session",
      })
      return c.json({ ok: true })
    })
    await (
      await app.request("/v1/messages", {
        ...requestOptions,
        headers: {
          "x-session-affinity": "original-session",
          "user-agent": "usage-client/1.0",
        },
      })
    ).text()
    await plugins.flush()
    const persisted = await getTokenUsageEventsPage({
      period: "lifetime",
      page: 1,
      pageSize: 10,
    })
    expect(usages).toHaveLength(1)
    expect(usages[0].requestId).toBe(starts[0].id)
    expect(usages[0].session_id).toBe("original-session")
    expect(usages[0].sessionId).toBe("original-session")
    expect(starts[0].sessionId).toBe("original-session")
    expect(ends[0].sessionId).toBe("original-session")
    expect(sessions).toHaveLength(0)
    expect(usages[0].userAgent).toBe("usage-client/1.0")
    expect(persisted.items[0].session_id).toBe("original-session")
    expect(persisted.items[0]).not.toHaveProperty("userAgent")
    expect(persisted.items[0]).not.toHaveProperty("sessionId")
    expect(persisted.items[0].total_tokens).toBe(5)
  })

  test("publishes a payload-derived session before response or usage is available", async () => {
    const { app, plugins, starts, sessions, ends } = await appWithEvents()
    let sessionReady = () => {}
    const ready = new Promise<void>((resolveReady) => {
      sessionReady = resolveReady
    })
    let release = () => {}
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    await plugins.register("session-observer", ({ on }) => {
      on("request.session", sessionReady)
    })
    app.post("/v1/messages", async (c) => {
      const body = await c.req.json<{ model: string; session: string }>()
      setPluginRequestModel(body.model)
      createTokenUsageRecorder({
        source: "provider",
        providerName: "test",
        endpoint: "messages",
        model: body.model,
        sessionId: body.session,
        fallbackSessionId: "fallback-session",
      })
      await gate
      return c.json({ ok: true })
    })
    const pending = app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "test-model", session: "payload-session" }),
    })
    await ready
    try {
      await plugins.flush()
      expect(starts[0].sessionId).toBeNull()
      expect(sessions.map((e) => e.sessionId)).toEqual(["payload-session"])
      expect(ends).toHaveLength(0)
    } finally {
      release()
    }
    await (await pending).text()
    await plugins.flush()
    expect(ends[0].sessionId).toBe("payload-session")
  })

  test("uses existing fallback session resolution and leaves unknown sessions null", async () => {
    const { app, plugins, starts, sessions, ends } = await appWithEvents()
    app.post("/v1/messages", async (c) => {
      const body = await c.req.json<{ fallbackSession?: string }>()
      createTokenUsageRecorder({
        source: "provider",
        endpoint: "messages",
        model: "test-model",
        fallbackSessionId: body.fallbackSession,
      })
      return c.json({ ok: true })
    })
    await (
      await app.request("/v1/messages", { method: "POST", body: "{}" })
    ).text()
    await (
      await app.request("/v1/messages", {
        method: "POST",
        body: JSON.stringify({ fallbackSession: "existing-fallback" }),
      })
    ).text()
    await plugins.flush()
    expect(starts.map((e) => e.sessionId)).toEqual([null, null])
    expect(ends.map((e) => e.sessionId)).toEqual([null, "existing-fallback"])
    expect(sessions.map((e) => e.sessionId)).toEqual(["existing-fallback"])
  })

  test("integrates with the actual Responses router on a non-default port", async () => {
    const plugins = runtime()
    const models: Array<GatewayPluginEvents["request.model"]> = []
    const ends: Array<GatewayPluginEvents["request.end"]> = []
    await plugins.register("integration", ({ on }) => {
      on("request.model", (e) => {
        models.push(e)
      })
      on("request.end", (e) => {
        ends.push(e)
      })
    })
    const { createServer } = await import("~/server")
    const { providerResponsesHandlerDependencies } = await import(
      "~/routes/provider/responses/handler"
    )
    const original = providerResponsesHandlerDependencies.resolveProviderConfig
    providerResponsesHandlerDependencies.resolveProviderConfig = () =>
      Promise.resolve(null)
    try {
      const app = createServer({ plugins, port: 5000, getApiKeys: () => [] })
      const response = await app.request("/missing/v1/responses", {
        method: "POST",
        body: Bun.zstdCompressSync(payload),
        headers: { "content-encoding": "zstd", host: "public.example.com" },
      })
      await response.text()
      await plugins.flush()
      expect(models[0].model).toBe("original/model")
      expect(ends[0]).toMatchObject({
        port: 5000,
        status: 400,
        outcome: "error",
      })
    } finally {
      providerResponsesHandlerDependencies.resolveProviderConfig = original
    }
  })

  test("example plugin writes snapshots and timings entirely outside core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-monitor-"))
    process.env.COPILOT_API_MONITOR_DIR = dir
    const plugins = await loadGatewayPlugins(
      JSON.stringify([resolve("plugin/gateway/monitor.mjs")]),
      { port: 5000, baseDir: dir },
    )
    runtimes.push(plugins!)
    const path = join(dir, `inflight-5000-${process.pid}.json`)
    expect(existsSync(path)).toBe(true)
    plugins!.publish("request.start", info)
    plugins!.publish("request.model", { ...info, model: "test-model" })
    await plugins!.flush()
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      requests: {
        "request-1": { model: "test-model", user_agent: "plugin-test/1.0" },
      },
    })
    plugins!.publish("request.session", {
      ...info,
      sessionId: "existing-session",
    })
    await plugins!.flush()
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      requests: { "request-1": { session_id: "existing-session" } },
    })
    plugins!.publish("request.end", {
      ...info,
      model: "test-model",
      sessionId: "existing-session",
      durationMs: 5,
      firstChunkMs: null,
      status: 200,
      outcome: "completed",
    })
    await plugins!.flush()
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      requests: {},
    })
    const line = JSON.parse(
      readFileSync(join(dir, "timings-1970-01.jsonl"), "utf8"),
    ) as { port: string; ms: number }
    expect(line).toMatchObject({
      port: "5000",
      ms: 5,
      user_agent: "plugin-test/1.0",
      session_id: "existing-session",
    })
    await plugins!.close()
    expect(existsSync(path)).toBe(false)
  })
})
