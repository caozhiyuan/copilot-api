import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

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
import {
  recordResponsesFirstToken,
  recordAnthropicFirstToken,
} from "~/lib/first-token"
import {
  requestContext,
  setPluginRequestActualModel,
} from "~/lib/request-context"
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
  const actualModels: Array<GatewayPluginEvents["request.actual_model"]> = []
  const tokens: Array<GatewayPluginEvents["request.first_token"]> = []
  const sessions: Array<GatewayPluginEvents["request.session"]> = []
  const ends: Array<GatewayPluginEvents["request.end"]> = []
  await plugins.register("collector", ({ on }) => {
    on("request.start", (event) => {
      starts.push(event)
    })
    on("request.model", (event) => {
      models.push(event)
    })
    on("request.actual_model", (event) => {
      actualModels.push(event)
    })
    on("request.session", (event) => {
      sessions.push(event)
    })
    on("request.first_token", (event) => {
      tokens.push(event)
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
  return { app, plugins, starts, models, actualModels, sessions, tokens, ends }
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
  actualModel: null,
}

async function expectFailure(promise: Promise<unknown>, message: string) {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain(message)
}

async function waitForSnapshot(
  path: string,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (predicate(value)) return value
    }
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for monitor snapshot: ${path}`)
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
  test("keeps requested and actual models separate and snapshots actual target updates", async () => {
    const { app, plugins, starts, models, actualModels, ends } =
      await appWithEvents()
    let lateUpdate = () => {}
    app.post("/v1/messages", (c) => {
      setPluginRequestModel("client-alias")
      setPluginRequestActualModel("")
      setPluginRequestActualModel("resolved-model")
      setPluginRequestActualModel("resolved-model")
      setPluginRequestActualModel("fallback-model")
      const observer = requestContext.getStore()!.pluginRequest!
      lateUpdate = () => observer.setActualModel("too-late")
      return c.text("ok")
    })
    await (await app.request("/v1/messages", requestOptions)).text()
    lateUpdate()
    await plugins.flush()
    expect(starts[0].actualModel).toBeNull()
    expect(models[0]).toMatchObject({
      model: "client-alias",
      actualModel: null,
    })
    expect(actualModels.map((e) => e.actualModel)).toEqual([
      "resolved-model",
      "fallback-model",
    ])
    expect(actualModels.every((e) => e.model === "client-alias")).toBe(true)
    expect(ends[0]).toMatchObject({
      model: "client-alias",
      actualModel: "fallback-model",
    })
  })

  test("reuses handler parsing, keeps metadata immutable and preserves response headers", async () => {
    const { app, plugins, starts, models, ends, tokens } = await appWithEvents()
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
      firstTokenMs: null,
      sessionId: null,
    })
    expect(tokens).toHaveLength(0)
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

  test("keeps TTFT unknown for heartbeat-only streams without reparsing the body", async () => {
    const { app, plugins, ends, tokens } = await appWithEvents()
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
    expect(tokens).toHaveLength(0)
    release()
    while (!(await reader.read()).done) {
      /* drain */
    }
    await plugins.flush()
    expect(tokens).toHaveLength(0)
    expect(ends[0].firstTokenMs).toBeNull()
  })

  test.each(["Responses", "Anthropic"] as const)(
    "%s thinking starts set TTFT before visible content and only once",
    async (protocol) => {
      const { app, plugins, ends, tokens } = await appWithEvents()
      let now = 100
      const clock = spyOn(performance, "now").mockImplementation(() => now)
      let releaseThinking = () => {}
      const thinkingGate = new Promise<void>((resolveGate) => {
        releaseThinking = resolveGate
      })
      let releaseOutput = () => {}
      const outputGate = new Promise<void>((resolveGate) => {
        releaseOutput = resolveGate
      })
      const delta = {
        type: "response.output_text.delta" as const,
        content_index: 0,
        delta: "",
        item_id: "msg-1",
        output_index: 0,
        sequence_number: 1,
      }
      const recordOutput = (text: string) => {
        if (protocol === "Responses")
          recordResponsesFirstToken({ ...delta, delta: text })
        else
          recordAnthropicFirstToken({
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text },
          })
      }
      const path = protocol === "Responses" ? "/v1/responses" : "/v1/messages"
      app.post(path, (c) =>
        streamSSE(c, async (stream) => {
          recordOutput("")
          await stream.writeSSE({ event: "ping", data: "{}" })
          await thinkingGate
          if (protocol === "Responses") {
            recordResponsesFirstToken({
              type: "response.output_item.added",
              output_index: 0,
              sequence_number: 0,
              item: {
                id: "reasoning-1",
                type: "reasoning",
                status: "in_progress",
                summary: [],
              },
            })
          } else {
            recordAnthropicFirstToken({
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "" },
            })
          }
          await stream.writeSSE({ event: "thinking-start", data: "{}" })
          await outputGate
          recordOutput("Hello")
          await stream.writeSSE({ data: "Hello" })
          now = 900
          recordOutput(" world")
          await stream.writeSSE({ data: " world" })
        }),
      )
      try {
        const response = await app.request(path, requestOptions)
        const reader = (
          response.body! as ReadableStream<Uint8Array>
        ).getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          "ping",
        )
        await plugins.flush()
        expect(tokens).toHaveLength(0)
        now = 250
        releaseThinking()
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          "thinking-start",
        )
        await plugins.flush()
        expect(tokens).toHaveLength(1)
        expect(tokens[0]).toMatchObject({
          firstTokenMs: 150,
          userAgent: "plugin-test/1.0",
        })
        expect(ends).toHaveLength(0)
        now = 450
        releaseOutput()
        while (!(await reader.read()).done) {
          /* drain */
        }
        await plugins.flush()
        expect(tokens).toHaveLength(1)
        expect(tokens[0]).not.toHaveProperty("delta")
        expect(ends[0]).toMatchObject({
          firstTokenMs: 150,
          durationMs: 800,
          outcome: "completed",
        })
      } finally {
        releaseThinking()
        releaseOutput()
        clock.mockRestore()
      }
    },
  )

  test("ignores model output observed after client abort", async () => {
    const { app, plugins, ends, tokens } = await appWithEvents()
    let recordFirstToken = () => {}
    app.post("/v1/responses", (c) => {
      const observer = requestContext.getStore()!.pluginRequest!
      recordFirstToken = () => observer.recordFirstToken()
      return c.text("aborted")
    })
    const controller = new AbortController()
    controller.abort()
    await (
      await app.request("/v1/responses", {
        ...requestOptions,
        signal: controller.signal,
      })
    ).text()
    recordFirstToken()
    await plugins.flush()
    expect(tokens).toHaveLength(0)
    expect(ends[0]).toMatchObject({ firstTokenMs: null, outcome: "cancelled" })
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
    const { app, plugins, ends, tokens } = await appWithEvents()
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
    expect(tokens).toHaveLength(0)
    expect(ends[0]).toMatchObject({ outcome: "error", firstTokenMs: null })
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
    expect(usages[0].actualModel).toBe("test-model")
    expect(persisted.items[0].session_id).toBe("original-session")
    expect(persisted.items[0].user_agent).toBe("usage-client/1.0")
    expect(persisted.items[0]).not.toHaveProperty("userAgent")
    expect(persisted.items[0]).not.toHaveProperty("sessionId")
    expect(persisted.items[0]).not.toHaveProperty("actualModel")
    expect(persisted.items[0].total_tokens).toBe(5)
  })

  test("truncates stored User-Agent to 64 characters while retaining plugin request metadata", async () => {
    process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
    const { app, plugins, starts } = await appWithEvents()
    const usages: Array<GatewayPluginEvents["usage.recorded"]> = []
    await plugins.register("usage-header", ({ on }) => {
      on("usage.recorded", (event) => {
        usages.push(event)
      })
    })
    const userAgent = "custom-agent/" + "x".repeat(100)
    app.post("/v1/messages", (c) => {
      recordTokenUsageEvent({
        source: "copilot",
        endpoint: "messages",
        model: "test",
        output_tokens: 1,
      })
      return c.text("ok")
    })
    await (
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "user-agent": userAgent },
      })
    ).text()
    await plugins.flush()
    const persisted = await getTokenUsageEventsPage({
      period: "today",
      page: 1,
      pageSize: 10,
    })
    expect(persisted.items[0].user_agent).toBe(userAgent.slice(0, 64))
    expect(starts[0].userAgent).toBe(userAgent)
    expect(usages[0].userAgent).toBe(userAgent)
    expect(usages[0].user_agent).toBe(userAgent.slice(0, 64))
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

  test("captures TTFT through the actual Responses stream parser", async () => {
    const { app, plugins, tokens, ends } = await appWithEvents()
    const { handleResponses, responsesHandlerDependencies } = await import(
      "~/routes/responses/handler"
    )
    const original = { ...responsesHandlerDependencies }
    responsesHandlerDependencies.resolveMappedModel = (model) => model
    responsesHandlerDependencies.findEndpointModel = (id) => ({
      id,
      name: id,
      object: "model",
      model_picker_enabled: true,
      preview: false,
      vendor: "test",
      version: "1",
      capabilities: {
        family: "test",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "test",
        type: "chat",
      },
      supported_endpoints: ["/responses"],
    })
    let reads = 0
    responsesHandlerDependencies.createResponses = () =>
      Promise.resolve(
        (async function* () {
          await Promise.resolve()
          for (const event of [
            {
              type: "response.output_item.added",
              output_index: 0,
              sequence_number: 0,
              item: {
                type: "message",
                id: "msg-1",
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            },
            {
              type: "response.output_text.delta",
              item_id: "msg-1",
              output_index: 0,
              content_index: 0,
              sequence_number: 1,
              delta: "",
            },
            {
              type: "response.output_text.delta",
              item_id: "msg-1",
              output_index: 0,
              content_index: 0,
              sequence_number: 2,
              delta: "Hello",
            },
            {
              type: "response.output_text.done",
              item_id: "msg-1",
              output_index: 0,
              content_index: 0,
              sequence_number: 3,
              text: "Hello",
            },
          ]) {
            reads++
            yield { event: event.type, data: JSON.stringify(event) }
          }
        })(),
      )
    app.post("/v1/responses", handleResponses)
    try {
      const response = await app.request("/v1/responses", {
        ...requestOptions,
        body: JSON.stringify({
          model: "gpt-plugin-test",
          input: "hello",
          stream: true,
        }),
      })
      const text = await response.text()
      await plugins.flush()
      expect(text).toContain('"delta":"Hello"')
      expect(reads).toBe(4)
      expect(tokens).toHaveLength(1)
      expect(tokens[0].firstTokenMs).toBeGreaterThanOrEqual(0)
      expect(ends[0]).toMatchObject({
        firstTokenMs: tokens[0].firstTokenMs,
        outcome: "completed",
      })
    } finally {
      Object.assign(responsesHandlerDependencies, original)
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
    expect(
      await waitForSnapshot(
        path,
        (value) =>
          (value as { requests?: Record<string, { model?: string }> })
            .requests?.["request-1"]?.model === "test-model",
      ),
    ).toMatchObject({
      requests: {
        "request-1": { model: "test-model", user_agent: "plugin-test/1.0" },
      },
    })
    plugins!.publish("request.actual_model", {
      ...info,
      model: "test-model",
      actualModel: "resolved-model",
    })
    await plugins!.flush()
    expect(
      await waitForSnapshot(
        path,
        (value) =>
          (value as { requests?: Record<string, { actual_model?: string }> })
            .requests?.["request-1"]?.actual_model === "resolved-model",
      ),
    ).toMatchObject({
      requests: {
        "request-1": { model: "test-model", actual_model: "resolved-model" },
      },
    })
    plugins!.publish("request.session", {
      ...info,
      sessionId: "existing-session",
    })
    await plugins!.flush()
    expect(
      await waitForSnapshot(
        path,
        (value) =>
          (value as { requests?: Record<string, { session_id?: string }> })
            .requests?.["request-1"]?.session_id === "existing-session",
      ),
    ).toMatchObject({
      requests: { "request-1": { session_id: "existing-session" } },
    })
    plugins!.publish("request.first_token", { ...info, firstTokenMs: 2.4 })
    await plugins!.flush()
    expect(
      await waitForSnapshot(
        path,
        (value) =>
          (value as { requests?: Record<string, { ttft_ms?: number | null }> })
            .requests?.["request-1"]?.ttft_ms === 2,
      ),
    ).toMatchObject({
      requests: { "request-1": { ttft_ms: 2 } },
    })
    plugins!.publish("request.end", {
      ...info,
      model: "test-model",
      actualModel: "resolved-model",
      sessionId: "existing-session",
      durationMs: 5,
      firstTokenMs: 2.4,
      status: 200,
      outcome: "completed",
    })
    await plugins!.flush()
    expect(
      await waitForSnapshot(
        path,
        (value) =>
          Object.keys(
            (value as { requests?: Record<string, unknown> }).requests ?? {},
          ).length === 0,
      ),
    ).toMatchObject({
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
      ttft_ms: 2,
      actual_model: "resolved-model",
    })
    await plugins!.close()
    expect(existsSync(path)).toBe(false)
  })
})
